"""
Machine Learning Model Module for F1 Standing Predictor.

Handles data cleaning, train/test splitting, XGBRanker training with eval_set
integration, model evaluation against X_test (NDCG, Spearman correlation,
winner & podium accuracy), and model persistence.
"""

import datetime
import os
from typing import Any, Dict, Optional, Tuple

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.metrics import ndcg_score
from xgboost import XGBRanker

# Evaluation / feature columns
COLS_EVAL = [
    'air_temp', 'rainfall', 'wind_speed', 'quali_relative_time',
    'driver_points', 'constructor_points', 'constructors_ewma', 'driver_ewma'
]

# Original column renaming dictionary
COL_NAME = {
    'Round': "round",
    'Year': "year",
    'RaceName': "race_name",
    'MeetingKey': "meeting_key",
    'SessionKey': "session_key",
    'CircuitKey': "circuit_key",
    'CircuitShortName': "circuit_name",
    'StartDate': "start_date",
    'DriverNumber': "driver_number",
    'FullName': "full_name",
    'Abbreviation': "abv",
    'DriverId': "driver_id",
    'TeamId': "team_id",
    'Position': "finish_position",
    'GridPosition': "grid_position",
    'ClassifiedPosition': "classified_position",
    'Status': "status",
    'Points': "race_points",
    'Time': "race_finish_time",
    'Laps': "laps",
    'AirTemp': "air_temp",
    'RainFall': "rainfall",
    'WindSpeed': "wind_speed",
    'QualiTime': "quali_relative_time",
    'DriverPoints': "driver_points",
    'ConstructorPoints': "constructor_points",
    'TeamAverageFinishEWMA': "constructors_ewma",
    'EWMAFinishPosition': "driver_ewma",
    'relevance_score': "relevance_score"
}

DROP_COLS = [
    'start_date', 'status', 'full_name', 'abv', 'race_points', 'meeting_key',
    'circuit_name', 'circuit_key', 'round', 'race_name', 'driver_number',
    'classified_position', 'finish_position', 'grid_position', 'laps',
    'team_id', 'race_finish_time'
]


def load_and_clean_data(csv_path: str = "predictor/data/driver_results_final.csv") -> pd.DataFrame:
    """
    Loads raw CSV data and performs cleaning and feature transformations:
    - Renames columns with col_name
    - Drops unnecessary columns
    - Converts quali_relative_time to milliseconds
    - Imputes missing EWMA with 20.0 and missing relevance_score with 0.0
    Returns cleaned_df.
    """
    raw_data = pd.read_csv(csv_path)
    data_df = raw_data.copy()

    col_name = COL_NAME
    data_df.rename(columns=col_name, inplace=True)
    data_df.drop(DROP_COLS, axis=1, inplace=True)
    data_df = data_df.sort_values(by=['year', 'session_key']).reset_index(drop=True)

    # Convert qualifying relative time to milliseconds
    data_df['quali_relative_time'] = pd.to_timedelta(data_df['quali_relative_time'])
    data_df['quali_relative_time'] = data_df['quali_relative_time'].map(
        lambda x: ((x / datetime.timedelta(microseconds=1)) / 1000)
    )

    for col in ['constructors_ewma', 'driver_ewma']:
        data_df[col] = data_df[col].map(lambda x: 20.0 if pd.isna(x) else x)

    for col in ['relevance_score']:
        data_df[col] = data_df[col].map(lambda x: 0.0 if pd.isna(x) else x)

    cleaned_df = data_df.copy()
    return cleaned_df


def split_data(
    cleaned_df: pd.DataFrame,
    split_year: int = 2024
) -> Dict[str, Any]:
    """
    Splits cleaned dataset into training (< split_year) and testing (>= split_year)
    and prepares feature matrices (X), targets (y), and group IDs (qid).
    """
    train_mask = cleaned_df['year'] < split_year
    test_mask = cleaned_df['year'] >= split_year

    train_df = cleaned_df[train_mask].sort_values(by=['session_key'])
    test_df = cleaned_df[test_mask].sort_values(by=['session_key'])

    y_train = train_df['relevance_score'].copy()
    y_test = test_df['relevance_score'].copy()

    X_train = train_df.copy().drop(['relevance_score', 'year', 'session_key', 'driver_id'], axis=1)
    X_test = test_df.copy().drop(['relevance_score', 'year', 'session_key', 'driver_id'], axis=1)

    qid_train = train_df.session_key.copy()
    qid_test = test_df.session_key.copy()

    return {
        'train_df': train_df,
        'test_df': test_df,
        'X_train': X_train,
        'y_train': y_train,
        'qid_train': qid_train,
        'X_test': X_test,
        'y_test': y_test,
        'qid_test': qid_test
    }


def train_ranker(
    X_train: pd.DataFrame,
    y_train: pd.Series,
    qid_train: pd.Series,
    X_test: Optional[pd.DataFrame] = None,
    y_test: Optional[pd.Series] = None,
    qid_test: Optional[pd.Series] = None,
    learning_rate: float = 0.05,
    max_depth: int = 6,
    n_estimators: int = 100,
    tree_method: str = 'hist',
    objective: str = 'rank:ndcg',
    eval_metric: str = 'ndcg@5',
    ndcg_exp_gain: bool = False
) -> XGBRanker:
    """
    Initializes and fits XGBRanker model. Integrates test set evaluation
    during training if X_test is provided.
    """
    ranker = XGBRanker(
        tree_method=tree_method,
        objective=objective,
        eval_metric=eval_metric,
        learning_rate=learning_rate,
        max_depth=max_depth,
        n_estimators=n_estimators,
        ndcg_exp_gain=ndcg_exp_gain
    )

    if X_test is not None and y_test is not None and qid_test is not None:
        ranker.fit(
            X_train,
            y_train,
            qid=qid_train,
            eval_set=[(X_test, y_test)],
            eval_qid=[qid_test],
            verbose=False
        )
    else:
        ranker.fit(X_train, y_train, qid=qid_train)

    return ranker


def evaluate_model(
    ranker: XGBRanker,
    X_test: pd.DataFrame,
    y_test: pd.Series,
    qid_test: pd.Series,
    test_df: pd.DataFrame
) -> Dict[str, Any]:
    """
    Comprehensive evaluation of XGBRanker model on test dataset:
    - NDCG@5 and NDCG@10 (ranking quality)
    - Spearman rank correlation
    - P1 (Race Winner) Prediction Accuracy
    - Top-3 (Podium) Recall Percentage
    - Feature importances
    """
    ndcg_5_list = []
    ndcg_10_list = []
    spearman_list = []
    p1_matches = 0
    podium_overlaps = []

    for session_key, group in test_df.groupby('session_key'):
        features = group.drop(['relevance_score', 'year', 'session_key', 'driver_id'], axis=1)
        actual_relevance = group['relevance_score'].to_numpy()
        preds = ranker.predict(features)

        if len(actual_relevance) > 1 and actual_relevance.max() > actual_relevance.min():
            ndcg_5 = ndcg_score([actual_relevance], [preds], k=5)
            ndcg_10 = ndcg_score([actual_relevance], [preds], k=10)
            ndcg_5_list.append(ndcg_5)
            ndcg_10_list.append(ndcg_10)

            corr, _ = spearmanr(actual_relevance, preds)
            if not np.isnan(corr):
                spearman_list.append(corr)

        # Check winner (P1)
        if np.argmax(preds) == np.argmax(actual_relevance):
            p1_matches += 1

        # Check podium (Top 3)
        pred_podium = set(np.argsort(preds)[-3:])
        actual_podium = set(np.argsort(actual_relevance)[-3:])
        podium_overlaps.append(len(pred_podium.intersection(actual_podium)) / 3.0)

    num_sessions = test_df['session_key'].nunique()
    feature_names = list(X_test.columns)
    feature_importances = dict(zip(feature_names, [float(x) for x in ranker.feature_importances_]))

    results = {
        'num_sessions_evaluated': int(num_sessions),
        'mean_ndcg_at_5': float(np.mean(ndcg_5_list)) if ndcg_5_list else 0.0,
        'mean_ndcg_at_10': float(np.mean(ndcg_10_list)) if ndcg_10_list else 0.0,
        'mean_spearman_correlation': float(np.mean(spearman_list)) if spearman_list else 0.0,
        'p1_winner_matches': int(p1_matches),
        'p1_winner_accuracy_pct': float((p1_matches / num_sessions) * 100) if num_sessions > 0 else 0.0,
        'mean_podium_recall_pct': float(np.mean(podium_overlaps) * 100) if podium_overlaps else 0.0,
        'feature_importances': feature_importances
    }
    return results


def save_model(ranker: XGBRanker, filepath: str = "predictor/ranker_model.json") -> None:
    """Saves trained XGBRanker model to JSON file."""
    os.makedirs(os.path.dirname(os.path.abspath(filepath)), exist_ok=True)
    ranker.save_model(filepath)
    print(f"Model saved to {filepath}")


def load_model(filepath: str = "predictor/ranker_model.json") -> XGBRanker:
    """Loads trained XGBRanker model from JSON file."""
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Model file not found at {filepath}")
    ranker = XGBRanker()
    ranker.load_model(filepath)
    return ranker

