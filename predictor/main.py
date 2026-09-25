"""
Command-Line Interface for F1 Standing Predictor.

Commands:
  train       - Preprocess data, fit XGBRanker with eval_set, evaluate on test set, save model & predictions JSON
  evaluate    - Evaluate saved model on test set (NDCG, Spearman, P1 accuracy, Podium recall)
  predict     - Predict standings for a specific race (from CSV or FastF1)
  export      - Export predictions for web frontend to predictions.json
  serve       - Launch the lightweight REST API server
  pipeline    - Run FastF1 + Ergast data collection pipeline to rebuild CSV
"""

import argparse
import os
import sys
from typing import Optional

# Ensure project root is in sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from predictor.data_pipeline import run_full_data_pipeline
from predictor.model import (
    evaluate_model,
    load_and_clean_data,
    load_model,
    save_model,
    split_data,
    train_ranker,
)
from predictor.predict_service import (
    export_predictions_json,
    format_standings_display,
    get_race_data,
    predict_session_standings,
)
from predictor.server import run_server


def cmd_train(args):
    print("=" * 60)
    print("🏎️  F1 STANDINGS PREDICTOR: MODEL TRAINING & EVALUATION")
    print("=" * 60)

    print("\n1. Loading and cleaning dataset...")
    cleaned_df = load_and_clean_data(args.csv)
    print(f"   Cleaned dataset shape: {cleaned_df.shape}")

    print("\n2. Splitting into Train (< 2024) and Test (>= 2024)...")
    splits = split_data(cleaned_df, split_year=args.split_year)
    X_train, y_train, qid_train = splits['X_train'], splits['y_train'], splits['qid_train']
    X_test, y_test, qid_test = splits['X_test'], splits['y_test'], splits['qid_test']
    test_df = splits['test_df']

    print(f"   Train samples: {len(X_train)} across {qid_train.nunique()} sessions")
    print(f"   Test samples:  {len(X_test)} across {qid_test.nunique()} sessions")

    print("\n3. Fitting XGBRanker with test set evaluation...")
    ranker = train_ranker(
        X_train, y_train, qid_train,
        X_test=X_test, y_test=y_test, qid_test=qid_test,
        learning_rate=args.lr,
        max_depth=args.max_depth,
        n_estimators=args.n_estimators
    )

    print("\n4. Evaluating Model against Test Set (X_test)...")
    metrics = evaluate_model(ranker, X_test, y_test, qid_test, test_df)

    print("-" * 60)
    print("📊 EVALUATION METRICS ON TEST SET:")
    print(f"   • Total Test Sessions Evaluated: {metrics['num_sessions_evaluated']}")
    print(f"   • Mean NDCG@5:                   {metrics['mean_ndcg_at_5']:.4f}")
    print(f"   • Mean NDCG@10:                  {metrics['mean_ndcg_at_10']:.4f}")
    print(f"   • Mean Spearman Rank Correlation:{metrics['mean_spearman_correlation']:.4f}")
    print(f"   • P1 Race Winner Accuracy:       {metrics['p1_winner_matches']}/{metrics['num_sessions_evaluated']} ({metrics['p1_winner_accuracy_pct']:.1f}%)")
    print(f"   • Mean Podium (Top 3) Recall:    {metrics['mean_podium_recall_pct']:.1f}%")
    print("-" * 60)

    print("\n5. Feature Importances:")
    for feat, imp in metrics['feature_importances'].items():
        bar = "█" * int(imp * 40)
        print(f"   {feat:22s} | {imp:.4f} {bar}")

    print(f"\n6. Saving trained model to {args.model_path}...")
    save_model(ranker, args.model_path)

    print("\n7. Exporting predictions for web frontend...")
    export_predictions_json(ranker, model_path=args.model_path, csv_path=args.csv)

    print("\n✅ Training, evaluation, and export complete!")


def cmd_evaluate(args):
    print("=" * 60)
    print("🏎️  F1 STANDINGS PREDICTOR: MODEL EVALUATION")
    print("=" * 60)

    cleaned_df = load_and_clean_data(args.csv)
    splits = split_data(cleaned_df, split_year=args.split_year)
    X_test, y_test, qid_test = splits['X_test'], splits['y_test'], splits['qid_test']
    test_df = splits['test_df']

    ranker = load_model(args.model_path)
    metrics = evaluate_model(ranker, X_test, y_test, qid_test, test_df)

    print(f"\nEvaluated on {metrics['num_sessions_evaluated']} test sessions:")
    print(f"  NDCG@5:                    {metrics['mean_ndcg_at_5']:.4f}")
    print(f"  NDCG@10:                   {metrics['mean_ndcg_at_10']:.4f}")
    print(f"  Spearman Correlation:      {metrics['mean_spearman_correlation']:.4f}")
    print(f"  P1 Winner Accuracy:        {metrics['p1_winner_accuracy_pct']:.1f}% ({metrics['p1_winner_matches']}/{metrics['num_sessions_evaluated']})")
    print(f"  Podium (Top 3) Recall:     {metrics['mean_podium_recall_pct']:.1f}%")


def cmd_predict(args):
    print("=" * 60)
    print("🏎️  F1 STANDINGS PREDICTOR: RACE PREDICTION")
    print("=" * 60)

    try:
        ranker = load_model(args.model_path)
    except FileNotFoundError:
        print(f"Model not found at {args.model_path}. Please train first with: python predictor/main.py train")
        sys.exit(1)

    race_df, metadata = get_race_data(
        year=args.year,
        round_num=args.round,
        race_name=args.name,
        session_key=args.session,
        csv_path=args.csv
    )

    ranked_df = predict_session_standings(ranker, race_df)
    standings = format_standings_display(ranked_df)

    print(f"\n📍 Grand Prix: {metadata.get('race_name', 'Race')} ({metadata.get('year', '')})")
    print(f"   Round:      {metadata.get('round', '')} | Circuit: {metadata.get('circuit', '')}")
    print(f"   Source:     {metadata.get('source', '')}\n")

    print(f"{'POS':<4} {'DRIVER':<22} {'TEAM':<15} {'SCORE':<9} {'ACTUAL':<8} {'ACCURACY'}")
    print("-" * 65)

    for item in standings:
        pos_badge = f"P{item['predicted_position']}"
        driver_str = f"{item['full_name']} ({item['abbreviation']})"
        actual_str = f"P{item['actual_position']}" if item['actual_position'] is not None else "-"
        delta = item['accuracy_delta']
        if delta is None:
            delta_str = ""
        elif delta == 0:
            delta_str = "🎯 Exact match"
        elif delta > 0:
            delta_str = f"+{delta} pos higher"
        else:
            delta_str = f"{delta} pos lower"

        print(f"{pos_badge:<4} {driver_str:<22} {item['team_id']:<15} {item['prediction_score']:<9.4f} {actual_str:<8} {delta_str}")


def cmd_export(args):
    print("Exporting predictions for web app...")
    export_predictions_json(
        model_path=args.model_path,
        csv_path=args.csv,
        output_path="predictor/predictions.json"
    )
    print("Done!")


def cmd_serve(args):
    run_server(port=args.port, host=args.host)


def cmd_pipeline(args):
    print(f"Executing data extraction pipeline for years: {args.years}")
    run_full_data_pipeline(args.years, temp_csv_path=args.temp_csv, final_csv_path=args.csv)


def main():
    parser = argparse.ArgumentParser(description="Formula 1 Standing Predictor CLI")
    parser.add_argument("--csv", default="predictor/data/driver_results_final.csv", help="Path to final driver results CSV")
    parser.add_argument("--model-path", default="predictor/ranker_model.json", help="Path to save/load XGBRanker model")

    subparsers = parser.add_subparsers(dest="command", help="Command to execute")

    # train
    p_train = subparsers.add_parser("train", help="Train and evaluate ranker model")
    p_train.add_argument("--split-year", type=int, default=2024, help="Year cutoff for train/test split")
    p_train.add_argument("--lr", type=float, default=0.05, help="Learning rate")
    p_train.add_argument("--max-depth", type=int, default=6, help="Maximum tree depth")
    p_train.add_argument("--n-estimators", type=int, default=100, help="Number of trees")
    p_train.set_defaults(func=cmd_train)

    # evaluate
    p_eval = subparsers.add_parser("evaluate", help="Evaluate model against test set")
    p_eval.add_argument("--split-year", type=int, default=2024)
    p_eval.set_defaults(func=cmd_evaluate)

    # predict
    p_pred = subparsers.add_parser("predict", help="Predict standings for a race")
    p_pred.add_argument("--year", type=int, default=None, help="Championship year (e.g. 2024)")
    p_pred.add_argument("--round", type=int, default=None, help="Round number (e.g. 1)")
    p_pred.add_argument("--name", type=str, default=None, help="Race name substring (e.g. Italian)")
    p_pred.add_argument("--session", type=int, default=None, help="FastF1 SessionKey (e.g. 11361)")
    p_pred.set_defaults(func=cmd_predict)

    # export
    p_export = subparsers.add_parser("export", help="Export predictions to JSON")
    p_export.set_defaults(func=cmd_export)

    # serve
    p_serve = subparsers.add_parser("serve", help="Start REST API server")
    p_serve.add_argument("--port", type=int, default=8000, help="Server port")
    p_serve.add_argument("--host", type=str, default="127.0.0.1", help="Server host")
    p_serve.set_defaults(func=cmd_serve)

    # pipeline
    p_pipe = subparsers.add_parser("pipeline", help="Run full data collection pipeline")
    p_pipe.add_argument("--years", nargs="+", type=int, default=[2025, 2026], help="Years to collect")
    p_pipe.add_argument("--temp-csv", default="predictor/driver_temp_results.csv")
    p_pipe.set_defaults(func=cmd_pipeline)

    args = parser.parse_args()
    if hasattr(args, "func"):
        args.func(args)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
