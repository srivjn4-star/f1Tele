"""
Lightweight REST API Server for F1 Standing Predictor.

Uses Python's built-in http.server to provide full CORS-enabled REST endpoints
for the web frontend without needing external packages like Flask or FastAPI:
- GET /api/health: Health check
- GET /api/races: List of available races with metadata
- GET /api/predict?year=YYYY&round=R or ?session_key=K: Predict race standings
- GET /api/predictions: Pre-computed predictions JSON
"""

import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, Dict, Optional

# Ensure project root is in sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from predictor.model import load_model
from predictor.predict_service import (
    format_standings_display,
    get_available_races,
    get_race_data,
    predict_session_standings,
)

# Shared in-memory model cache
LOADED_RANKER = None


def get_cached_ranker():
    """Lazily loads and caches the trained model in memory."""
    global LOADED_RANKER
    if LOADED_RANKER is None:
        try:
            LOADED_RANKER = load_model("predictor/ranker_model.json")
        except Exception:
            # If model not saved yet, train it on the fly
            from predictor.model import load_and_clean_data, split_data, train_ranker, save_model
            cleaned_df = load_and_clean_data()
            splits = split_data(cleaned_df)
            LOADED_RANKER = train_ranker(
                splits['X_train'], splits['y_train'], splits['qid_train'],
                splits['X_test'], splits['y_test'], splits['qid_test']
            )
            save_model(LOADED_RANKER)
    return LOADED_RANKER


class PredictorAPIHandler(BaseHTTPRequestHandler):
    """HTTP request handler for F1 Predictor API."""

    def _send_cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _send_json_response(self, status_code: int, data: Any):
        payload = json.dumps(data, indent=2).encode('utf-8')
        self.send_response(status_code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        """Handles preflight CORS requests."""
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        """Routes GET requests to appropriate API endpoints."""
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path
        params = urllib.parse.parse_qs(parsed_url.query)

        # Health endpoint
        if path == '/api/health':
            self._send_json_response(200, {
                'status': 'healthy',
                'service': 'F1 Standing Predictor API',
                'version': '1.0.0'
            })
            return

        # Available races endpoint
        if path == '/api/races':
            try:
                races = get_available_races()
                self._send_json_response(200, {'races': races})
            except Exception as e:
                self._send_json_response(500, {'error': f'Failed to load races: {str(e)}'})
            return

        # Single race prediction endpoint
        if path == '/api/predict':
            try:
                ranker = get_cached_ranker()

                # Extract query parameters
                session_key = int(params['session_key'][0]) if 'session_key' in params else None
                year = int(params['year'][0]) if 'year' in params else None
                round_num = int(params['round'][0]) if 'round' in params else None
                race_name = params['race_name'][0] if 'race_name' in params else None

                # Default to latest session if nothing passed
                if session_key is None and year is None and race_name is None:
                    session_key = 11361  # Italian GP 2026

                race_df, metadata = get_race_data(
                    year=year,
                    round_num=round_num,
                    race_name=race_name,
                    session_key=session_key
                )

                ranked_df = predict_session_standings(ranker, race_df)
                standings = format_standings_display(ranked_df)

                response_data = {
                    'metadata': metadata,
                    'weather': {
                        'air_temp': round(float(race_df['air_temp'].iloc[0]), 1) if 'air_temp' in race_df else None,
                        'rainfall_pct': round(float(race_df['rainfall'].iloc[0]) * 100, 1) if 'rainfall' in race_df else None,
                        'wind_speed': round(float(race_df['wind_speed'].iloc[0]), 1) if 'wind_speed' in race_df else None
                    },
                    'standings': standings
                }
                self._send_json_response(200, response_data)

            except Exception as e:
                self._send_json_response(500, {'error': f'Prediction failed: {str(e)}'})
            return

        # Full precomputed predictions document
        if path == '/api/predictions':
            try:
                with open("predictor/predictions.json", "r", encoding="utf-8") as f:
                    data = json.load(f)
                self._send_json_response(200, data)
            except Exception:
                # If file doesn't exist, generate it
                from predictor.predict_service import export_predictions_json
                ranker = get_cached_ranker()
                data = export_predictions_json(ranker)
                self._send_json_response(200, data)
            return

        self._send_json_response(404, {'error': f'Endpoint {path} not found'})


def run_server(port: int = 8000, host: str = "127.0.0.1") -> None:
    """Starts the Predictor API server."""
    server_address = (host, port)
    httpd = HTTPServer(server_address, PredictorAPIHandler)
    print(f"\n🏎️  F1 Predictor API Server running at http://{host}:{port}/")
    print(f"👉 Available endpoints:")
    print(f"   - http://{host}:{port}/api/health")
    print(f"   - http://{host}:{port}/api/races")
    print(f"   - http://{host}:{port}/api/predict?session_key=11361")
    print(f"   - http://{host}:{port}/api/predict?year=2024&round=1")
    print(f"   - http://{host}:{port}/api/predictions\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        httpd.server_close()


if __name__ == '__main__':
    run_server()
