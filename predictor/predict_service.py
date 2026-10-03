"""
Prediction and Data Resolution Service for F1 Standing Predictor.

Provides:
- Intelligent race data resolution (CSV lookup first, dynamic FastF1/Ergast fallback)
- Aggregate feature calculation for new races
- Session prediction & standings ranking
- Standings formatting and export to JSON for web frontend
"""

import datetime
import json
import os
from typing import Any, Dict, List, Optional, Tuple

import fastf1
import numpy as np
import pandas as pd
from xgboost import XGBRanker

from predictor.data_pipeline import (
    calc_EWMA,
    enable_fastf1_cache,
        find_minimum_time,
    process_weather_data,
    compute_ewma_and_relevance,
    group_by_session,
)
from predictor.model import COLS_EVAL, load_and_clean_data, load_model


def get_available_races(csv_path: str = "predictor/data/driver_results_final.csv") -> List[Dict[str, Any]]:
    """
    Returns a list of all distinct races available in the dataset with metadata.
    """
    raw_df = pd.read_csv(csv_path)
    races_df = raw_df[['Year', 'Round', 'RaceName', 'CircuitShortName', 'SessionKey']].drop_duplicates()
    races_df = races_df.sort_values(by=['Year', 'Round'], ascending=[False, True])

    races = []
    for _, row in races_df.iterrows():
        races.append({
            'year': int(row['Year']),
            'round': int(row['Round']),
            'race_name': str(row['RaceName']),
            'circuit': str(row['CircuitShortName']),
            'session_key': int(row['SessionKey']),
            'label': f"{int(row['Year'])} Round {int(row['Round'])}: {str(row['RaceName'])}"
        })
    return races


def resolve_race_from_csv(
    raw_df: pd.DataFrame,
    year: Optional[int] = None,
    round_num: Optional[int] = None,
    race_name: Optional[str] = None,
    session_key: Optional[int] = None
) -> Optional[pd.DataFrame]:
    """
    Searches the existing dataset for the requested race.
    """
    filtered = raw_df.copy()

    if session_key is not None:
        matched = filtered[filtered['SessionKey'] == session_key]
        if not matched.empty:
            return matched

    if year is not None:
        filtered = filtered[filtered['Year'] == year]

    if round_num is not None:
        matched = filtered[filtered['Round'] == round_num]
        #HOW DO WE KNOW THAT THIS HAS EXACTLY ONE RACE IT CAN HAVE MANY IF YEAR WAS NONE HOW IS THIS PRECONDIITON NOT CHECKED? THIS FAILS POST CONDITION
        if not matched.empty:
            return matched

    if race_name is not None and not filtered.empty:
        matched = filtered[filtered['RaceName'].str.lower().str.contains(race_name.lower(), na=False)]
        if not matched.empty:
            return matched

    return None



def _compute_relative_quali_times(quali_res: pd.DataFrame, max_ms: float = 9960000.0) -> Dict[str, pd.Timedelta]:
    """Finds the fastest Q time for each driver, calculates the relative delta, and replaces None with max_ms."""
    fastest_time = None
    quali_times = {}
    for _, row in quali_res.iterrows():
        min_time = find_minimum_time(row.get('Q1'), row.get('Q2'), row.get('Q3'))
        quali_times[row['DriverId']] = min_time
        if min_time is not None and not pd.isna(min_time):
            if fastest_time is None or min_time < fastest_time:
                fastest_time = min_time

    quali_delta_ms = {}
    for driver_id, t in quali_times.items():
        if t is not None and fastest_time is not None and not pd.isna(t):
            quali_delta_ms[driver_id] = t - fastest_time
        else:
            quali_delta_ms[driver_id] = pd.Timedelta(milliseconds=max_ms)
    return quali_delta_ms


def _extract_session_metadata(year: int, event: Any, session_to_use: Any, is_future: bool) -> Dict[str, Any]:
    """Extracts structured metadata needed for the pipeline and API response."""
    round_val = int(event['RoundNumber'])
    race_name = str(event.get('EventName', 'Grand Prix'))

    #ERM WOT
    meeting_key = int(event.get('EventDate').timestamp())
    try:
        meeting_key = session_to_use.session_info['Meeting']['Key']
    except Exception: pass
    
    session_key = getattr(session_to_use, 'session_info', {}).get('Key', int(datetime.datetime.now().timestamp()))
    
    circuit_key = event.get('Location', '')
    try:
        circuit_key = session_to_use.session_info['Meeting']['Circuit']['Key']
    except Exception: pass
    
    return {
        'year': year,
        'round_val': round_val,
        'race_name': race_name,
        'meeting_key': meeting_key,
        'session_key': session_key,
        'circuit_key': circuit_key,
        'circuit_name': str(event.get('Location', '')),
        'start_date': getattr(session_to_use, 'date', datetime.datetime.now()),
        'source': 'FastF1 Live Fetch (Quali Only)' if is_future else 'FastF1 Live Fetch'
    }


def _build_session_records(
    results_to_use: pd.DataFrame, 
    meta: Dict[str, Any], 
    weather: Tuple[float, float, float], 
    quali_delta_ms: Dict[str, pd.Timedelta], 
    is_future: bool
) -> List[List]:
    """Maps the live session results into the standard COLUMNS_TEMP list structure."""
    new_records = []
    air_temp, rainfall, wind_speed = weather
    
    for _, row in results_to_use.iterrows():
        driver_id = row['DriverId']
        q_time = quali_delta_ms.get(driver_id, pd.Timedelta(milliseconds=9960000.0))
        pos = np.nan if is_future else row.get('Position', np.nan)
        
        new_records.append([
            meta['round_val'], meta['year'], meta['race_name'], meta['meeting_key'], 
            meta['session_key'], meta['circuit_key'], meta['circuit_name'], meta['start_date'],
            row.get('DriverNumber', 0),
            row.get('FullName', driver_id),
            row.get('Abbreviation', ''),
            driver_id,
            row.get('TeamId', ''),
            pos,
            row.get('GridPosition', np.nan),
            row.get('ClassifiedPosition', ''),
            row.get('Status', ''),
            row.get('Points', 0.0),
            row.get('Time', pd.NaT),
            row.get('Laps', 0),
            air_temp, rainfall, wind_speed, q_time
        ])
    return new_records


def _process_and_format_ewma(new_records: List[List], session_key: int, temp_csv_path: str) -> pd.DataFrame:
    """Appends new records to temp dataset, runs EWMA, and formats features for XGBRanker."""
    temp_df = pd.read_csv(temp_csv_path)
    records = temp_df.values.tolist()
    records.extend(new_records)

    grouped = group_by_session(records)
    _, final_df = compute_ewma_and_relevance(grouped)
    
    race_df = final_df[final_df['SessionKey'] == session_key].copy()
    
    for col in ['TeamAverageFinishEWMA', 'EWMAFinishPosition']:
        race_df[col] = race_df[col].map(lambda x: 20.0 if pd.isna(x) else float(x))
    
    race_df.rename(columns={'TeamAverageFinishEWMA': 'constructors_ewma', 'EWMAFinishPosition': 'driver_ewma'}, inplace=True)
    
    race_df['quali_relative_time'] = pd.to_timedelta(race_df['QualiTime'])
    race_df['quali_relative_time'] = race_df['quali_relative_time'].map(
        lambda x: ((x / datetime.timedelta(microseconds=1)) / 1000)
    )
    race_df['air_temp'] = race_df['AirTemp'].astype(float)
    race_df['rainfall'] = race_df['RainFall'].astype(float)
    race_df['wind_speed'] = race_df['WindSpeed'].astype(float)
    
    return race_df

def _fetch_and_calculate_features_unified(
    year: int,
    round_num_or_name: Any,
    csv_history_path: str = "predictor/data/driver_results_final.csv",
    is_future: bool = False
) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """
    Unified function to fetch a race (past or future), format it as COLUMNS_TEMP,
    append to the temporary CSV records, and run the standard EWMA pipeline.
    """
    enable_fastf1_cache()
    event = fastf1.get_event(year, round_num_or_name)
    
    quali_session = event.get_session('Q')
    quali_session.load()
    quali_delta_ms = _compute_relative_quali_times(quali_session.results)

    if is_future:
        session_to_use = quali_session
        results_to_use = quali_session.results
    else:
        session_to_use = event.get_session('R')
        session_to_use.load()
        results_to_use = session_to_use.results

    weather = process_weather_data([session_to_use.weather_data])[0]
    meta = _extract_session_metadata(year, event, session_to_use, is_future)
    
    new_records = _build_session_records(results_to_use, meta, weather, quali_delta_ms, is_future)
    
    race_df = _process_and_format_ewma(new_records, meta['session_key'], temp_csv_path="predictor/driver_temp_results.csv")

    metadata = {
        'year': meta['year'],
        'round': meta['round_val'],
        'race_name': meta['race_name'],
        'circuit': meta['circuit_name'],
        'session_key': meta['session_key'],
        'source': meta['source']
    }
    return race_df, metadata
def fetch_and_calculate_race_features(year: int, round_num_or_name: Any, csv_history_path: str = "predictor/data/driver_results_final.csv"):
    return _fetch_and_calculate_features_unified(year, round_num_or_name, csv_history_path, is_future=False)

def fetch_and_calculate_future_race_features(year: int, round_num_or_name: Any, csv_history_path: str = "predictor/data/driver_results_final.csv"):
    return _fetch_and_calculate_features_unified(year, round_num_or_name, csv_history_path, is_future=True)
def get_race_data(
    year: Optional[int] = None,
    round_num: Optional[int] = None,
    race_name: Optional[str] = None,
    session_key: Optional[int] = None,
    csv_path: str = "predictor/data/driver_results_final.csv"
) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """
    Intelligent race resolver:
    1. Looks in CSV file first.
    2. If absent, dynamically fetches from FastF1 & Ergast and calculates aggregates.
    """
    raw_df = pd.read_csv(csv_path)
    matched_df = resolve_race_from_csv(raw_df, year, round_num, race_name, session_key)

    if matched_df is not None and not matched_df.empty:
        first_row = matched_df.iloc[0]
        metadata = {
            'year': int(first_row['Year']),
            'round': int(first_row['Round']),
            'race_name': str(first_row['RaceName']),
            'circuit': str(first_row['CircuitShortName']),
            'session_key': int(first_row['SessionKey']),
            'source': 'Local Dataset (CSV)'
        }

        # Format features according to model expectations
        processed_df = matched_df.copy()
        processed_df['quali_relative_time'] = pd.to_timedelta(processed_df['QualiTime'])
        processed_df['quali_relative_time'] = processed_df['quali_relative_time'].map(
            lambda x: ((x / datetime.timedelta(microseconds=1)) / 1000)
        )

        for col, col_orig in [('constructors_ewma', 'TeamAverageFinishEWMA'), ('driver_ewma', 'EWMAFinishPosition')]:
            processed_df[col] = processed_df[col_orig].map(lambda x: 20.0 if pd.isna(x) else float(x))

        processed_df['air_temp'] = processed_df['AirTemp'].astype(float)
        processed_df['rainfall'] = processed_df['RainFall'].astype(float)
        processed_df['wind_speed'] = processed_df['WindSpeed'].astype(float)

        return processed_df, metadata

    # If not in CSV, fetch dynamically
    if year is None:
        raise ValueError("Year must be provided to fetch race from FastF1.")
    target = round_num if round_num is not None else race_name
    return fetch_and_calculate_race_features(year, target, csv_path)


def predict_session_standings(
    ranker: XGBRanker,
    race_features_df: pd.DataFrame,
    cols_eval: Optional[List[str]] = None
) -> pd.DataFrame:
    """
    Executes model inference on the session's driver feature matrix
    and sorts the output descending by predicted ranking score.
    """
    if cols_eval is None:
        cols_eval = COLS_EVAL

    one_session = race_features_df.copy()
    feature_matrix = one_session[cols_eval]

    preds = ranker.predict(feature_matrix)
    one_session.insert(0, 'prediction', preds)
    ranked_df = one_session.sort_values(by='prediction', ascending=False).reset_index(drop=True)
    return ranked_df


def format_standings_display(ranked_df: pd.DataFrame) -> List[Dict[str, Any]]:
    """
    Formats ranked predictions into a human-readable list of driver prediction objects.
    """
    standings = []
    for rank, (_, row) in enumerate(ranked_df.iterrows(), start=1):
        actual_pos = row.get('Position', None)
        actual_pos_int = int(actual_pos) if (actual_pos is not None and not pd.isna(actual_pos)) else None

        standings.append({
            'predicted_position': rank,
            'driver_id': str(row.get('DriverId', '')),
            'full_name': str(row.get('FullName', row.get('DriverId', ''))),
            'abbreviation': str(row.get('Abbreviation', '')),
            'driver_number': int(row.get('DriverNumber', 0)) if not pd.isna(row.get('DriverNumber', 0)) else 0,
            'team_id': str(row.get('TeamId', '')),
            'prediction_score': round(float(row['prediction']), 4),
            'actual_position': actual_pos_int,
            'accuracy_delta': (actual_pos_int - rank) if actual_pos_int is not None else None,
            'quali_time_ms': round(float(row.get('quali_relative_time', 0.0)), 2)
        })
    return standings


def export_predictions_json(
    ranker: Optional[XGBRanker] = None,
    model_path: str = "predictor/ranker_model.json",
    csv_path: str = "predictor/data/driver_results_final.csv",
    output_path: str = "predictor/predictions.json",
    web_public_path: str = "predictions.json"
) -> Dict[str, Any]:
    """
    Computes predictions for all recent test races (2024-2026) and exports
    a structured JSON document consumable directly by the frontend web application.
    """
    if ranker is None:
        ranker = load_model(model_path)

    raw_df = pd.read_csv(csv_path)
    available_races = get_available_races(csv_path)

    # Focus on test years (2024-2026) for frontend display
    test_races = [r for r in available_races if r['year'] >= 2024]
    export_data = {
        'generated_at': datetime.datetime.now().isoformat(),
        'model_type': 'XGBRanker (LambdaMART NDCG)',
        'races': []
    }

    for race_meta in test_races:
        try:
            race_df, meta = get_race_data(session_key=race_meta['session_key'], csv_path=csv_path)
            ranked_df = predict_session_standings(ranker, race_df)
            standings = format_standings_display(ranked_df)

            export_data['races'].append({
                'year': race_meta['year'],
                'round': race_meta['round'],
                'race_name': race_meta['race_name'],
                'circuit': race_meta['circuit'],
                'session_key': race_meta['session_key'],
                'weather': {
                    'air_temp': round(float(race_df['air_temp'].iloc[0]), 1),
                    'rainfall_pct': round(float(race_df['rainfall'].iloc[0]) * 100, 1),
                    'wind_speed': round(float(race_df['wind_speed'].iloc[0]), 1)
                },
                'standings': standings
            })
        except Exception as e:
            print(f"Warning: could not export predictions for session {race_meta['session_key']}: {e}")

    # --- ADD NEW FUTURE RACE ---
    try:
        current_year = datetime.datetime.now().year
        future_race_df, future_meta = fetch_and_calculate_future_race_features(current_year, 'Azerbaijan', csv_path)
        ranked_df = predict_session_standings(ranker, future_race_df)
        standings = format_standings_display(ranked_df)

        export_data['races'].append({
            'year': future_meta['year'],
            'round': future_meta['round'],
            'race_name': future_meta['race_name'],
            'circuit': future_meta['circuit'],
            'session_key': future_meta['session_key'],
            'weather': {
                'air_temp': round(float(future_race_df['air_temp'].iloc[0]), 1),
                'rainfall_pct': round(float(future_race_df['rainfall'].iloc[0]) * 100, 1),
                'wind_speed': round(float(future_race_df['wind_speed'].iloc[0]), 1)
            },
            'standings': standings
        })
        print(f"Added future race: {future_meta['race_name']}")
    except Exception as e:
        print(f"Warning: could not export predictions for future race: {e}")
    # -----------------------------

    # Write to predictor/predictions.json
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(export_data, f, indent=2)
    print(f"Exported {len(export_data['races'])} race predictions to {output_path}")

    # Also save to root directory for direct static fetch by web app
    try:
        with open(web_public_path, 'w', encoding='utf-8') as f:
            json.dump(export_data, f, indent=2)
        print(f"Synced predictions to {web_public_path}")
    except Exception as e:
        print(f"Note: Could not mirror predictions to {web_public_path}: {e}")

    return export_data



# --- NEW FUNCTIONS ADDED FOR FASTAPI INTEGRATION ---

import logging
logger = logging.getLogger(__name__)

def cache_single_race_prediction(response_data: Dict[str, Any], output_path: str = "predictor/predictions.json", web_public_path: str = "predictions.json"):
    """
    Appends a single race prediction to the existing predictions.json without recalculating all races.
    """
    logger.info(f"Caching new race prediction for {response_data['metadata']['race_name']}")
    try:
        if os.path.exists(output_path):
            with open(output_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        else:
            data = {
                'generated_at': datetime.datetime.now().isoformat(),
                'model_type': 'XGBRanker (LambdaMART NDCG)',
                'races': []
            }

        # Check if already exists, if so, replace
        session_key = response_data['metadata']['session_key']
        existing_idx = next((i for i, r in enumerate(data['races']) if r.get('session_key') == session_key), None)
        
        race_entry = {
            'year': response_data['metadata']['year'],
            'round': response_data['metadata']['round'],
            'race_name': response_data['metadata']['race_name'],
            'circuit': response_data['metadata']['circuit'],
            'session_key': session_key,
            'weather': response_data['weather'],
            'standings': response_data['standings']
        }

        if existing_idx is not None:
            data['races'][existing_idx] = race_entry
        else:
            data['races'].append(race_entry)

        # Sort races ascending by year and round to maintain chronological order
        data['races'].sort(key=lambda x: (x.get('year', 0), x.get('round', 0)), reverse=False)

        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
            
        try:
            with open(web_public_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.warning(f"Could not mirror predictions to {web_public_path}: {e}")
            
    except Exception as e:
        logger.error(f"Error caching single race: {e}")

def check_and_predict_new_races(ranker: Optional[XGBRanker] = None, csv_path: str = "predictor/data/driver_results_final.csv"):
    """
    Checks FastF1 for new races that have had their qualifying session finished,
    and automatically generates predictions for them if they aren't already cached.
    Ensures order is preserved for EWMA calculation.
    """
    logger.info("Checking for new finished qualifying sessions...")
    if ranker is None:
        ranker = load_model("predictor/ranker_model.json")

    current_year = datetime.datetime.now().year
    enable_fastf1_cache()
    
    try:
        schedule = fastf1.get_event_schedule(current_year)
    except Exception as e:
        logger.error(f"Could not fetch schedule from FastF1: {e}")
        return

    # Filter out testing and order chronologically
    valid_events = schedule[schedule['EventFormat'] != 'testing'].sort_values('RoundNumber')
    
    # Load existing cached predictions by year and round to avoid re-predicting
    cached_races = set()
    try:
        with open("predictor/predictions.json", "r", encoding="utf-8") as f:
            data = json.load(f)
            cached_races = {(r.get('year'), r.get('round')) for r in data.get('races', [])}
    except Exception:
        pass

    # Create a timezone-aware current time in UTC
    now_utc = datetime.datetime.now(datetime.timezone.utc)
    
    for _, event_row in valid_events.iterrows():
        round_num = event_row['RoundNumber']
        
        # 1. Skip if already cached
        if (current_year, round_num) in cached_races:
            continue
            
        # 2. Find the Qualifying session date from the schedule row
        q_date_utc = None
        for i in range(1, 6):
            if event_row.get(f'Session{i}') == 'Qualifying':
                # FastF1 schedule dates are Pandas Timestamps
                q_date_utc = event_row.get(f'Session{i}DateUtc')
                break
                
        # 3. If Quali has passed, fetch the heavy event data and predict
        if q_date_utc:
            # Ensure it's tz-aware for comparison
            if q_date_utc.tzinfo is None:
                q_date_utc = q_date_utc.replace(tzinfo=datetime.timezone.utc)
                
            if q_date_utc < now_utc:
                logger.info(f"Found new finished Quali for {current_year} Round {round_num}. Generating predictions...")
                try:
                    # Now we do the heavy fetching
                    race_df, metadata = get_race_data(year=current_year, round_num=round_num, csv_path=csv_path)
                    ranked_df = predict_session_standings(ranker, race_df)
                    standings = format_standings_display(ranked_df)
                    
                    response_data = {
                        "metadata": metadata,
                        "weather": {
                            "air_temp": round(float(race_df["air_temp"].iloc[0]), 1) if "air_temp" in race_df else None,
                            "rainfall_pct": round(float(race_df["rainfall"].iloc[0]) * 100, 1) if "rainfall" in race_df else None,
                            "wind_speed": round(float(race_df["wind_speed"].iloc[0]), 1) if "wind_speed" in race_df else None
                        },
                        "standings": standings
                    }
                    cache_single_race_prediction(response_data)
                    cached_races.add((current_year, round_num))
                    
                except Exception as pred_err:
                    logger.error(f"Failed to generate prediction for Round {round_num}: {pred_err}")
