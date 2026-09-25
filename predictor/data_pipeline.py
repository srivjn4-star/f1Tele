"""
Data Pipeline Module for F1 Standing Predictor.

Handles data extraction from FastF1 and Ergast, feature engineering
(qualifying deltas, weather averages, championship standings, EWMA statistics),
and dataset generation.
"""

import copy
import datetime
import time
from typing import List, Optional, Tuple

import fastf1
import numpy as np
import pandas as pd
from fastf1.ergast import Ergast

# Standard columns used throughout the pipeline
COLUMNS_TEMP = [
    'Round', 'Year', 'RaceName', 'MeetingKey', 'SessionKey', 'CircuitKey',
    'CircuitShortName', 'StartDate', 'DriverNumber', 'FullName', 'Abbreviation',
    'DriverId', 'TeamId', 'Position', 'GridPosition', 'ClassifiedPosition',
    'Status', 'Points', 'Time', 'Laps', 'AirTemp', 'RainFall', 'WindSpeed',
    'QualiTime', 'DriverPoints', 'ConstructorPoints'
]

COLUMNS_FINAL = [
    'Round', 'Year', 'RaceName', 'MeetingKey', 'SessionKey', 'CircuitKey',
    'CircuitShortName', 'StartDate', 'DriverNumber', 'FullName', 'Abbreviation',
    'DriverId', 'TeamId', 'Position', 'GridPosition', 'ClassifiedPosition',
    'Status', 'Points', 'Time', 'Laps', 'AirTemp', 'RainFall', 'WindSpeed',
    'QualiTime', 'DriverPoints', 'ConstructorPoints', 'TeamAverageFinishEWMA',
    'EWMAFinishPosition', 'relevance_score'
]


def enable_fastf1_cache(cache_dir: str = "predictor/cache") -> None:
    """Enables local FastF1 disk cache."""
    try:
        fastf1.Cache.enable_cache(cache_dir)
    except Exception as e:
        print(f"Warning: Could not enable FastF1 cache in '{cache_dir}': {e}")


def calc_EWMA(prev_EWMA: float, alpha: float, curr_value: float) -> float:
    """
    Calculates Exponentially Weighted Moving Average (EWMA).
    Formula: res = prev_EWMA * (1 - alpha) + alpha * curr_value
    """
    res = prev_EWMA * (1 - alpha)
    res = alpha * curr_value + res
    return res


def avg_constr_EWMA(race_idx: int, team: str, driver_list: List) -> float:
    """
    Computes constructor EWMA for a given race index and team based on
    the sum of finishes in the prior race session.
    """
    ewma = 0
    avg = 0
    prev_ewma = 0
    race = driver_list[race_idx]

    for driver in race:
        if driver[12] == team:
            avg += driver[13]
            prev_ewma = driver[26]

    ewma = calc_EWMA(prev_ewma, 0.56, avg)
    return ewma


def avg_driv_EWMA(driver_idx: int, driverId: str, driver_list: List) -> float:
    """
    Computes driver EWMA by searching backwards to find the driver's previous race.
    """
    ewma = 0
    prev_ewma = 0
    pt = 0
    i = driver_idx

    while i > 0:
        driver = driver_list[i]
        if driver[11] == driverId:
            prev_ewma = driver[27]
            pt = driver[13]
            break
        i -= 1

    ewma = calc_EWMA(prev_ewma, 0.56, pt)
    return ewma


def find_minimum_time(q1, q2, q3):
    """Finds the fastest (minimum) qualifying lap time across Q1, Q2, and Q3."""
    times = [q1, q2, q3]
    min_time = None
    for time_val in times:
        if time_val is not None and not pd.isna(time_val):
            if min_time is None or time_val < min_time:
                min_time = time_val
    return min_time


def find_driver_points(driverId: str, driver_standings: pd.DataFrame) -> float:
    """Finds current season points for a driver from Ergast standings."""
    driver_row = driver_standings.loc[driver_standings["driverId"] == driverId]
    if not driver_row.empty:
        return float(driver_row["points"].values[0])
    return 0.0


def find_constructor_points(teamId: str, constructor_standings: pd.DataFrame) -> float:
    """Finds current season points for a constructor from Ergast standings."""
    team_row = constructor_standings.loc[constructor_standings["constructorId"] == teamId]
    if not team_row.empty:
        return float(team_row["points"].values[0])
    return 0.0


def load_event_schedules(years: List[int]) -> List:
    """Fetches event schedules for specified years."""
    all_events_schedules = []
    for y in years:
        all_events_schedules.append(fastf1.get_event_schedule(y))
    return all_events_schedules


def get_all_events(all_events_schedules: List, max_rounds: int = 27) -> List:
    """Extracts all individual Grand Prix events from schedules."""
    all_events = []
    for event_schedule in all_events_schedules:
        for i in range(1, max_rounds + 1):
            try:
                all_events.append(event_schedule.get_event_by_round(i))
            except Exception:
                break
    return all_events


def get_race_sessions(all_events: List) -> List:
    """Extracts race sessions ('R') from events."""
    all_race_sessions = []
    for event in all_events:
        all_race_sessions.append(event.get_session('R'))
    return all_race_sessions


def get_qualifying_sessions(all_events: List) -> List:
    """Extracts qualifying sessions ('Q') from events."""
    all_qualifying_sessions = []
    for event in all_events:
        all_qualifying_sessions.append(event.get_session('Q'))
    return all_qualifying_sessions


def extract_race_data(all_race_sessions: List) -> Tuple[List, List, List]:
    """Preloads and extracts race results, session info, and weather data."""
    all_driver_results = []
    race_details = []
    temp_weather_data = []

    for race in all_race_sessions:
        try:
            race.load()
            all_driver_results.append(race.results)
            race_details.append(race.session_info)
            temp_weather_data.append(race.weather_data)
        except Exception as e:
            print(f"Error loading race session {getattr(race, 'event', 'unknown')}: {e}")

    return all_driver_results, race_details, temp_weather_data


def process_weather_data(temp_weather_data: List) -> List:
    """
    Computes mean air temperature, rainfall fraction, and mean wind speed
    for each session.
    """
    weather_data = []
    for weather in temp_weather_data:
        weather_data.append([weather['AirTemp'], weather['Rainfall'], weather['WindSpeed']])

    for race_weather in weather_data:
        race_weather[0] = sum(race_weather[0]) / len(race_weather[0]) if len(race_weather[0]) > 0 else 25.0
        race_weather[2] = sum(race_weather[2]) / len(race_weather[2]) if len(race_weather[2]) > 0 else 0.0
        count_rain = sum(1 for i in race_weather[1] if i is True)
        race_weather[1] = count_rain / len(race_weather[1]) if len(race_weather[1]) > 0 else 0.0

    return weather_data


def extract_qualifying_data(all_qualifying_sessions: List) -> Tuple[List, List]:
    """Preloads and extracts qualifying results and session info."""
    all_driver_quali_results = []
    quali_details = []

    for quali in all_qualifying_sessions:
        try:
            quali.load()
            all_driver_quali_results.append(quali.results)
            quali_details.append(quali.session_info)
        except Exception as e:
            print(f"Error loading qualifying session {getattr(quali, 'event', 'unknown')}: {e}")

    return all_driver_quali_results, quali_details


def organize_quali_data(all_driver_quali_results: List, quali_details: List) -> List:
    """
    Organizes qualifying results into driver objects and calculates relative
    qualifying times compared to the session pole lap.
    """
    organized_quali_data = []
    quali_event_count = 0

    for quali_result in all_driver_quali_results:
        quali_driver_count = 0
        race_object = []
        driver_count_total = len(quali_result["DriverNumber"])

        while quali_driver_count < driver_count_total:
            q1 = quali_result.iloc[quali_driver_count]["Q1"]
            q2 = quali_result.iloc[quali_driver_count]["Q2"]
            q3 = quali_result.iloc[quali_driver_count]["Q3"]
            min_time = find_minimum_time(q1, q2, q3)

            driver_obj = [
                quali_details[quali_event_count]["Meeting"]["Key"],
                quali_result.iloc[quali_driver_count]["DriverId"],
                min_time
            ]
            race_object.append(driver_obj)
            quali_driver_count += 1

        organized_quali_data.append(race_object)
        quali_event_count += 1

    # Make qualifying time relative to fastest session time
    for session_drivers in organized_quali_data:
        fastest_time = None
        for driver in session_drivers:
            if driver[2] is not None and not pd.isna(driver[2]):
                if fastest_time is None or driver[2] < fastest_time:
                    fastest_time = driver[2]

        for driver in session_drivers:
            if driver[2] is not None and not pd.isna(driver[2]):
                driver[2] = driver[2] - fastest_time
            else:
                driver[2] = datetime.MAXYEAR

    # Correct NaT to max_date
    max_date = pd.Timedelta('2h 45m 59s') + pd.Timedelta(1, unit='s')
    for quali_obj in organized_quali_data:
        for driver in quali_obj:
            if isinstance(driver[2], pd._libs.tslibs.nattype.NaTType) or pd.isna(driver[2]):
                driver[2] = max_date

    return organized_quali_data


def build_initial_driver_list(all_driver_results: List, race_details: List, weather_data: List) -> List:
    """Builds initial race driver rows containing session, driver, and weather info."""
    driver_list = []
    event_count = 0
    session_count = 1
    year_curr = None

    for driver_result in all_driver_results:
        race_driver_count = 0
        race_object = []
        total_drivers = len(driver_result["DriverNumber"])

        while race_driver_count < total_drivers:
            event_start = race_details[event_count]["StartDate"]
            if year_curr != event_start.year:
                year_curr = event_start.year
                session_count = 1

            driver_obj = [
                session_count,                                                   # 0: Round
                event_start.year,                                                # 1: Year
                race_details[event_count]["Meeting"]["Name"],                   # 2: RaceName
                race_details[event_count]["Meeting"]["Key"],                    # 3: MeetingKey
                race_details[event_count]["Key"],                               # 4: SessionKey
                race_details[event_count]["Meeting"]["Circuit"]["Key"],         # 5: CircuitKey
                race_details[event_count]["Meeting"]["Circuit"]["ShortName"],   # 6: CircuitShortName
                event_start,                                                     # 7: StartDate
                driver_result.iloc[race_driver_count]["DriverNumber"],           # 8: DriverNumber
                driver_result.iloc[race_driver_count]["FullName"],               # 9: FullName
                driver_result.iloc[race_driver_count]["Abbreviation"],           # 10: Abbreviation
                driver_result.iloc[race_driver_count]["DriverId"],               # 11: DriverId
                driver_result.iloc[race_driver_count]["TeamId"],                 # 12: TeamId
                driver_result.iloc[race_driver_count]["Position"],               # 13: Position
                driver_result.iloc[race_driver_count]["GridPosition"],           # 14: GridPosition
                driver_result.iloc[race_driver_count]["ClassifiedPosition"],     # 15: ClassifiedPosition
                driver_result.iloc[race_driver_count]["Status"],                 # 16: Status
                driver_result.iloc[race_driver_count]["Points"],                 # 17: Points
                driver_result.iloc[race_driver_count]["Time"],                   # 18: Time
                driver_result.iloc[race_driver_count]["Laps"],                   # 19: Laps
                weather_data[event_count][0],                                    # 20: AirTemp
                weather_data[event_count][1],                                    # 21: RainFall
                weather_data[event_count][2],                                    # 22: WindSpeed
            ]

            race_object.append(driver_obj)
            race_driver_count += 1

        event_count += 1
        session_count += 1
        driver_list.append(race_object)

    return driver_list


def attach_quali_to_race_data(driver_list: List, organized_quali_data: List) -> List:
    """Attaches qualifying delta to the corresponding driver rows using meeting key and driver id."""
    max_date = pd.Timedelta('2h 45m 59s') + pd.Timedelta(1, unit='s')

    for race_object in driver_list:
        try:
            meeting_key = race_object[0][3]
            for quali_object in organized_quali_data:
                if meeting_key == quali_object[0][0]:
                    for driver in race_object:
                        matched = False
                        for quali_driver in quali_object:
                            if driver[11] == quali_driver[1]:
                                driver.append(quali_driver[2])
                                matched = True
                                break
                        if not matched and len(driver) < 24:
                            driver.append(max_date)
        except Exception as e:
            print(f"Error matching quali data: {e}")

    # Ensure all driver objects have slot 23
    for race_obj in driver_list:
        for driver in race_obj:
            if len(driver) < 24:
                driver.append(max_date)
            if isinstance(driver[18], pd._libs.tslibs.nattype.NaTType) or pd.isna(driver[18]):
                driver[18] = max_date

    return driver_list


def attach_championship_standings(driver_list: List, ergast: Optional[Ergast] = None, delay_seconds: float = 1.0) -> List:
    """Attaches driver points and constructor points via Ergast API."""
    if ergast is None:
        ergast = Ergast()

    for session in driver_list:
        try:
            year = session[0][1]
            round_num = session[0][0]
            driver_standings = ergast.get_driver_standings(season=year, round=round_num).content[0]
            if delay_seconds > 0:
                time.sleep(delay_seconds)
            constructor_standings = ergast.get_constructor_standings(season=year, round=round_num).content[0]

            for driver in session:
                driverId = driver[11]
                teamId = driver[12]

                driver_points = find_driver_points(driverId=driverId, driver_standings=driver_standings)
                driver.append(driver_points)

                constructor_points = find_constructor_points(teamId=teamId, constructor_standings=constructor_standings)
                driver.append(constructor_points)
        except Exception as e:
            print(f"Warning: could not fetch Ergast standings for season {session[0][1]}, round {session[0][0]}: {e}")
            for driver in session:
                if len(driver) < 25:
                    driver.append(0.0)
                if len(driver) < 26:
                    driver.append(0.0)

    return driver_list


def flatten_driver_list(nested_driver_list: List) -> List:
    """Flattens a list of sessions/races into a flat list of driver records."""
    flat_list = []
    for race_object in nested_driver_list:
        for driver in race_object:
            flat_list.append(driver)
    return flat_list


def group_by_session(records: List) -> List:
    """Groups flat driver records back into per-session lists based on SessionKey (index 4)."""
    curr_session = None
    grouped = []
    group = []

    for row in records:
        sesh_key = row[4]
        if curr_session is None:
            curr_session = sesh_key
        elif curr_session != sesh_key:
            grouped.append(group)
            group = []
            curr_session = sesh_key
        group.append(row)

    if group:
        grouped.append(group)

    return grouped


def compute_ewma_and_relevance(driver_list_grouped: List) -> Tuple[List, pd.DataFrame]:
    """
    Computes:
    1. TeamAverageFinishEWMA (alpha=0.56)
    2. EWMAFinishPosition (alpha=0.56)
    3. relevance_score (23 - position)
    Returns (flat_driver_list, final_driver_df).
    """
    # 1. Constructor EWMA
    for i in range(len(driver_list_grouped)):
        race = driver_list_grouped[i]
        if i == 0:
            for driver in race:
                driver.append(0.0)
        else:
            for driver in race:
                team = driver[12]
                ewma_value = avg_constr_EWMA(i - 1, team, driver_list_grouped)
                driver.append(ewma_value)

    # Flatten before driver EWMA
    flat_driver_list = flatten_driver_list(driver_list_grouped)

    # 2. Driver EWMA
    for i in range(len(flat_driver_list)):
        driver1 = flat_driver_list[i]
        idx = i - 1
        driver1.append(avg_driv_EWMA(idx, driver1[11], flat_driver_list))

    # 3. Relevance Score: 23 - finish_position
    for driver in flat_driver_list:
        driver.append(23.0 - float(driver[13]))

    driver_df = pd.DataFrame(flat_driver_list, columns=COLUMNS_FINAL)
    return flat_driver_list, driver_df


def run_full_data_pipeline(
    years: List[int],
    temp_csv_path: str = "predictor/driver_temp_results.csv",
    final_csv_path: str = "predictor/data/driver_results_final.csv"
) -> pd.DataFrame:
    """
    End-to-end pipeline to collect data for specified years, compute all features,
    and save driver_results_final.csv.
    """
    enable_fastf1_cache()
    print(f"Loading event schedules for years: {years}...")
    all_events_schedules = load_event_schedules(years)
    all_events = get_all_events(all_events_schedules)

    print(f"Loading {len(all_events)} race and qualifying sessions...")
    all_race_sessions = get_race_sessions(all_events)
    all_qualifying_sessions = get_qualifying_sessions(all_events)

    all_driver_results, race_details, temp_weather_data = extract_race_data(all_race_sessions)
    weather_data = process_weather_data(temp_weather_data)

    all_driver_quali_results, quali_details = extract_qualifying_data(all_qualifying_sessions)
    organized_quali_data = organize_quali_data(all_driver_quali_results, quali_details)

    print("Building driver list and attaching qualifying data...")
    driver_list = build_initial_driver_list(all_driver_results, race_details, weather_data)
    driver_list = attach_quali_to_race_data(driver_list, organized_quali_data)

    print("Fetching Ergast standings...")
    driver_list = attach_championship_standings(driver_list)

    # Save temporary dataframe
    flat_driver_list_temp = flatten_driver_list(driver_list)
    driver_temp_df = pd.DataFrame(flat_driver_list_temp, columns=COLUMNS_TEMP)
    driver_temp_df['Position'] = driver_temp_df['Position'].map(lambda x: 20.0 if pd.isna(x) else x)
    driver_temp_df.to_csv(temp_csv_path, index=False)
    print(f"Saved temporary results to {temp_csv_path}")

    # Re-group by session to compute EWMA
    grouped_sessions = group_by_session(driver_temp_df.to_numpy().tolist())
    _, driver_df = compute_ewma_and_relevance(grouped_sessions)

    driver_df.to_csv(final_csv_path, index=False)
    print(f"Pipeline complete! Saved final dataset to {final_csv_path} ({len(driver_df)} rows).")
    return driver_df

