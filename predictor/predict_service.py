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
from fastf1.ergast import Ergast
from xgboost import XGBRanker

from predictor.data_pipeline import (
    calc_EWMA,
    enable_fastf1_cache,
    find_constructor_points,
    find_driver_points,
    find_minimum_time,
    process_weather_data,
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
        if not matched.empty:
            return matched

    if race_name is not None and not filtered.empty:
        matched = filtered[filtered['RaceName'].str.lower().str.contains(race_name.lower(), na=False)]
        if not matched.empty:
            return matched

    return None


def fetch_and_calculate_race_features(
    year: int,
    round_num_or_name: Any,
    csv_history_path: str = "predictor/data/driver_results_final.csv"
) -> Tuple[pd.DataFrame, Dict[str, Any]]:
    """
    Dynamically fetches an un-cached race from FastF1 + Ergast, computes
    aggregates (weather averages, relative quali time, championship points,
    historical EWMA for constructors and drivers), and prepares the feature matrix.
    """
    enable_fastf1_cache()
    print(f"Fetching race data from FastF1 for {year} {round_num_or_name}...")

    event = fastf1.get_event(year, round_num_or_name)
    race_session = event.get_session('R')
    quali_session = event.get_session('Q')

    race_session.load()
    quali_session.load()

    # Weather aggregates
    temp_weather = [race_session.weather_data]
    weather = process_weather_data(temp_weather)[0]
    air_temp, rainfall, wind_speed = weather[0], weather[1], weather[2]

    # Qualifying relative times
    quali_res = quali_session.results
    fastest_time = None
    quali_times = {}

    for _, row in quali_res.iterrows():
        min_time = find_minimum_time(row.get('Q1'), row.get('Q2'), row.get('Q3'))
        quali_times[row['DriverId']] = min_time
        if min_time is not None and not pd.isna(min_time):
            if fastest_time is None or min_time < fastest_time:
                fastest_time = min_time

    # Calculate relative timedelta in milliseconds
    max_ms = 9960000.0  # fallback delta for missing times
    quali_delta_ms = {}
    for driver_id, t in quali_times.items():
        if t is not None and fastest_time is not None and not pd.isna(t):
            delta = t - fastest_time
            ms = (delta / datetime.timedelta(microseconds=1)) / 1000.0
            quali_delta_ms[driver_id] = float(ms)
        else:
            quali_delta_ms[driver_id] = max_ms

    # Ergast standings
    ergast = Ergast()
    round_val = int(event['RoundNumber'])
    driver_points_map = {}
    constructor_points_map = {}

    try:
        d_standings = ergast.get_driver_standings(season=year, round=round_val).content[0]
        for _, r in d_standings.iterrows():
            driver_points_map[r['driverId']] = float(r['points'])
    except Exception:
        pass

    try:
        c_standings = ergast.get_constructor_standings(season=year, round=round_val).content[0]
        for _, r in c_standings.iterrows():
            constructor_points_map[r['constructorId']] = float(r['points'])
    except Exception:
        pass

    # Historical EWMA from history dataset
    history_df = pd.read_csv(csv_history_path)
    prior_races = history_df[
        (history_df['Year'] < year) |
        ((history_df['Year'] == year) & (history_df['Round'] < round_val))
    ]

    race_drivers = race_session.results
    rows = []

    for _, driver_row in race_drivers.iterrows():
        driver_id = driver_row['DriverId']
        team_id = driver_row['TeamId']

        # Historical constructor EWMA
        team_history = prior_races[prior_races['TeamId'] == team_id]
        if not team_history.empty:
            last_entry = team_history.iloc[-1]
            prev_ewma = float(last_entry.get('TeamAverageFinishEWMA', 20.0))
            last_pos = float(last_entry.get('Position', 20.0))
            constr_ewma = calc_EWMA(prev_ewma, 0.56, last_pos)
        else:
            constr_ewma = 20.0

        # Historical driver EWMA
        driver_history = prior_races[prior_races['DriverId'] == driver_id]
        if not driver_history.empty:
            last_entry = driver_history.iloc[-1]
            prev_ewma = float(last_entry.get('EWMAFinishPosition', 20.0))
            last_pos = float(last_entry.get('Position', 20.0))
            driver_ewma = calc_EWMA(prev_ewma, 0.56, last_pos)
        else:
            driver_ewma = 20.0

        d_pts = driver_points_map.get(driver_id, 0.0)
        c_pts = constructor_points_map.get(team_id, 0.0)
        q_time = quali_delta_ms.get(driver_id, max_ms)

        rows.append({
            'DriverId': driver_id,
            'FullName': driver_row.get('FullName', driver_id),
            'Abbreviation': driver_row.get('Abbreviation', ''),
            'DriverNumber': driver_row.get('DriverNumber', 0),
            'TeamId': team_id,
            'Position': driver_row.get('Position', np.nan),
            'air_temp': air_temp,
            'rainfall': rainfall,
            'wind_speed': wind_speed,
            'quali_relative_time': q_time,
            'driver_points': d_pts,
            'constructor_points': c_pts,
            'constructors_ewma': constr_ewma,
            'driver_ewma': driver_ewma
        })

    race_df = pd.DataFrame(rows)
    metadata = {
        'year': year,
        'round': round_val,
        'race_name': str(event.get('EventName', 'Grand Prix')),
        'circuit': str(event.get('Location', '')),
        'session_key': int(getattr(race_session, 'session_info', {}).get('Key', 0)),
        'source': 'FastF1 Live Fetch'
    }
    return race_df, metadata


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
        processed_df['driver_points'] = processed_df['DriverPoints'].astype(float)
        processed_df['constructor_points'] = processed_df['ConstructorPoints'].astype(float)

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
            'quali_time_ms': round(float(row.get('quali_relative_time', 0.0)), 2),
            'driver_points': float(row.get('driver_points', 0.0)),
            'constructor_points': float(row.get('constructor_points', 0.0))
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

