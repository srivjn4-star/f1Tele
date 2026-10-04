"""
FastAPI Server for F1 Standing Predictor.

Provides REST API endpoints for predicting F1 race standings.
Uses FastAPI for high performance and easy JSON serialization, replacing the built-in http.server.
"""

import json
import logging
import os
import sys
from fastapi import FastAPI, HTTPException, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from typing import Any, Dict, Optional
from contextlib import asynccontextmanager

# Ensure project root is in sys.path so we can import predictor modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from predictor.model import load_model, load_and_clean_data, split_data, train_ranker, save_model
from predictor.predict_service import (
    format_standings_display,
    get_available_races,
    get_race_data,
    predict_session_standings,
    export_predictions_json,
    cache_single_race_prediction,
    check_and_predict_new_races,
    check_and_predict_new_qualifications
)

# Configure logging (similar to Winston or Morgan in Node.js)
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Shared in-memory model cache
LOADED_RANKER = None


def get_cached_ranker():
    """Lazily loads and caches the trained model in memory."""
    global LOADED_RANKER
    if LOADED_RANKER is None:
        logger.info("Model not in memory. Attempting to load from disk...")
        try:
            LOADED_RANKER = load_model("predictor/ranker_model.json")
            logger.info("Model loaded successfully.")
        except Exception:
            logger.warning("Model file not found. Training model on the fly...")
            cleaned_df = load_and_clean_data()
            splits = split_data(cleaned_df)
            LOADED_RANKER = train_ranker(
                splits['X_train'], splits['y_train'], splits['qid_train'],
                splits['X_test'], splits['y_test'], splits['qid_test']
            )
            save_model(LOADED_RANKER)
            logger.info("Model trained and saved.")
    return LOADED_RANKER

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for startup and shutdown events."""
    logger.info("Server starting up. Checking for newly finished qualifying sessions...")
    try:
        ranker = get_cached_ranker()
        # Automatically updates predictions for any races that just finished Quali
        check_and_predict_new_races(ranker)
        logger.info("Finished fetching new races")
        check_and_predict_new_qualifications(ranker)
    except Exception as e:
        logger.error(f"Error during startup check for new races: {e}")
    yield
    # Add any shutdown logic here if needed
    logger.info("Server shutting down.")

# Initialize the FastAPI app (Equivalent to `const app = express()` in Node.js)
app = FastAPI(title="F1 Predictor API", version="1.0.0", lifespan=lifespan)

# Add CORS middleware
# Equivalent to `app.use(cors({ origin: [...] }))` in Express
# Restricted to the GitHub Pages frontend and localhost for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://srivjn4-star.github.io",
        "http://localhost:3000",
        "https://srivjn4-star.github.io/f1Tele/predictor.html",
        "http://127.0.0.1:3000/predictor.html",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:8001",
        "http://localhost:8000",
        "http://127.0.0.1:8000"
    ],
    allow_credentials=True,
    allow_methods=["*"],  # Allows all HTTP methods (GET, POST, etc.)
    allow_headers=["*"],
)

# Define a GET route. Equivalent to `app.get('/api/health', (req, res) => { res.json(...) })`
@app.get("/api/health")
def health_check():
    """Health check endpoint to verify server is running."""
    logger.info("Health check requested.")
    # FastAPI automatically serializes Python dictionaries to JSON responses
    return {
        "status": "healthy",
        "service": "F1 Standing Predictor API",
        "version": "1.0.0"
    }

@app.get("/api/races")
def get_races():
    """Returns a list of all available races."""
    logger.info("Races list requested.")
    try:
        races = get_available_races()
        return {"races": races}
    except Exception as e:
        logger.error(f"Failed to load races: {e}")
        # Throwing an HTTPException is like `res.status(500).json({ detail: ... })`
        raise HTTPException(status_code=500, detail=f"Failed to load races: {str(e)}")

@app.get("/api/predictions")
def get_all_predictions():
    """Returns the full precomputed predictions document."""
    logger.info("Full predictions JSON requested.")
    try:
        with open("predictor/predictions.json", "r", encoding="utf-8") as f:
            data = json.load(f)
        return data
    except Exception:
        logger.warning("predictions.json not found. Generating now...")
        ranker = get_cached_ranker()
        data = export_predictions_json(ranker)
        return data

# Using Query(...) allows extracting URL search params like `?session_key=123`
# Equivalent to `const session_key = req.query.session_key`
@app.get("/api/predict")
def predict_race(
    session_key: Optional[int] = Query(None, description="FastF1 Session Key"),
    year: Optional[int] = Query(None, description="Race Year"),
    round_num: Optional[int] = Query(None, alias="round", description="Race Round Number"),
    race_name: Optional[str] = Query(None, description="Race Name")
):
    """
    Predicts standings for a specific race.
    If it's a new race, dynamically predicts and appends to predictions.json.
    """
    logger.info(f"Prediction requested: session_key={session_key}, year={year}, round={round_num}")
    try:
        ranker = get_cached_ranker()
        
        # Check for auto-update of new races as part of the predict request lifecycle
        check_and_predict_new_races(ranker)
        check_and_predict_new_qualifications(ranker)

        # Default fallback session
        if session_key is None and year is None and race_name is None:
            session_key = 11361  # Fallback to an existing key for safety

        # Check if the requested prediction is already cached
        if session_key:
            try:
                with open("predictor/predictions.json", "r", encoding="utf-8") as f:
                    preds_data = json.load(f)
                for r in preds_data.get("races", []):
                    if r.get("session_key") == session_key:
                        logger.info("Found prediction in cache.")
                        return {
                            "metadata": {
                                "year": r.get("year"), "round": r.get("round"),
                                "race_name": r.get("race_name"), "circuit": r.get("circuit"),
                                "session_key": r.get("session_key"), "source": "Cache"
                            },
                            "weather": r.get("weather"),
                            "standings": r.get("standings")
                        }
            except Exception:
                pass # Proceed to predict if not in cache or file is missing

        # Fetch data and predict (falls back to FastF1 dynamically inside get_race_data)
        race_df, metadata = get_race_data(
            year=year,
            round_num=round_num,
            race_name=race_name,
            session_key=session_key
        )

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

        # Cache the new single race prediction so it is fast next time
        cache_single_race_prediction(response_data)

        return response_data

    except Exception as e:
        logger.error(f"Prediction failed: {e}")
        raise HTTPException(status_code=500, detail=f"Prediction failed: {str(e)}")

# Define a POST route. BackgroundTasks allow sending a response instantly 
# while the function runs asynchronously in the background.
@app.post("/api/update_predictions")
def update_all_predictions(background_tasks: BackgroundTasks):
    """
    Triggers a bulk recalculation of all test races and new races.
    """
    logger.info("Bulk update of predictions requested.")
    def update_task():
        try:
            ranker = get_cached_ranker()
            logger.info("Starting background export of predictions...")
            export_predictions_json(ranker)
            check_and_predict_new_races(ranker)
            check_and_predict_new_qualifications(ranker)
            logger.info("Background update completed.")
        except Exception as e:
            logger.error(f"Background update failed: {e}")

    background_tasks.add_task(update_task)
    return {"status": "Update started in background. This may take a few minutes."}
