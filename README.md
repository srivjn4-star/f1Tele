# F1 Telemetry & Race Predictor

An interactive Formula 1 telemetry analysis and machine learning-powered race prediction web platform. Built with Python, JavaScript, modern CSS, Chart.js, FastAPI, and FastF1.

🚀 **Live Web Application**: [https://srivjn4-star.github.io/f1Tele/](https://srivjn4-star.github.io/f1Tele/)

---

<!-- ================================================================= -->
<!-- SECTION: DRIVER COMPARISON & DRAGGABLE TRACK (Reserved for details) -->
<!-- ================================================================= -->

## 🏎️ Driver Comparison & Interactive Telemetry

The **Comparison** module provides synchronized, corner-by-corner telemetry analysis between two drivers for any selected Formula 1 Grand Prix. It connects to the **OpenF1 API** to stream real-time car telemetry, timing data, and GPS locations, visualizing them through an interactive 3-column stage and multi-metric charts.

### Key Capabilities

- **Head-to-Head Driver Selection**: Choose any Grand Prix from recent Formula 1 seasons and select two drivers to compare side-by-side with official team livery colors.
- **Lap-by-Lap Telemetry Inspection**: Select any completed race lap to load high-frequency telemetry intervals and compare cornering approaches, apex speeds, and throttle pickup.
- **Synchronized 3-Column Telemetry Stage**:
  - **Left Wing**:
    - **Driver A Vertical Readout Card**: Displays live telemetry metrics (Speed in km/h, Throttle percentage, Brake status/indicator, RPM, Gear, and DRS activation).
    - **Stadium Loop Lap Scrubber**: An interactive stadium track loop widget allowing users to scrub smoothly across the entire lap in the forward flow direction, with one-click toggles between Driver A and Driver B.
  - **Center Stage (Circuit Map)**:
    - **GPS Track Reconstruction**: Accurate track path derived from car location telemetry, color-coded into **Sector 1**, **Sector 2**, and **Sector 3** with a start/finish checkered flag.
    - **Smart Auto-Orientation**: Automatically detects vertically elongated circuits and rotates them 90° with aspect-ratio centering to maximize screen usage without manual panning.
    - **Interactive Draggable Car Markers**: Drag either driver's marker directly along the circuit track. Powered by native SVG inverse matrix transformation (`getScreenCTM().inverse()`) and localized continuity scoring, eliminating jumps across tight corners and hairpins. Moving one driver automatically updates the other car's relative position based on time delta.
  - **Right Wing**:
    - **Driver B Vertical Readout Card**: Displays Driver B's matching telemetry values in their respective team colors.
- **Synchronized Multi-Chart Viewer (Chart.js)**:
  - **01 Speed Chart**: Linear-scale multi-line graph comparing vehicle speed (km/h) across elapsed lap time.
  - **02 Throttle Chart**: Multi-line graph detailing throttle application percentage through corners and straights.
  - **03 Braking Swimlane**: Horizontal timeline zones comparing braking duration and braking onset points with aligned driver name labels.
  - **Synchronous Crosshair Cursors**: Scrubbing the loop widget or dragging car markers across the circuit instantly updates vertical guide lines and value badges across all three charts in real time.
- **Robust OpenF1 Error & Session Architecture**:
  - **Live Session Detection**: Flags live race weekends (HTTP 401/403) and displays informative alerts when OpenF1 restricts unauthenticated live streams.
  - **Rate-Limit Retry (HTTP 429)**: Built-in exponential backoff and retry handling with dedicated status alerts.
  - **Graceful Fallbacks & 404 Logging**: Optional assets (such as circuit satellite photography) fail gracefully with non-blocking warnings while core telemetry displays the vector circuit.

---

<!-- ================================================================= -->
<!-- SECTION: RACE WINNER PREDICTOR (Full Architecture & ML Details)  -->
<!-- ================================================================= -->

## 🔮 Race Winner & Standings Predictor

The **Predictor** module provides full-grid race finishing predictions using a trained Machine Learning ranking model (**XGBRanker**). It evaluates drivers using historical performance trends, qualifying deltas, and environmental track conditions to forecast race outcomes and podium finishes.

### Key Capabilities

- **Full Grid Ranking**: Predicts finishing orders (P1 to P22) along with model relevance scores.
- **Top 3 Podium Showcase**: Visually highlights the predicted podium finishers (P1, P2, and P3).
- **Post-Race Accuracy Auditing**: Computes position deltas (`🎯 Match`, `±N pos`) when official race results become available.
- **Dual-Mode Data Architecture**:
  - **Live Backend (FastAPI on Render)**: Fetches on-the-fly predictions and automatically runs pipeline checks for newly completed Qualifying and Race sessions.
  - **Local Precomputed Fallback (`predictions.json`)**: Instantly serves pre-calculated race predictions without waiting for the backend to wake up.
- **Cold-Start Resilience with `AbortController`**: The UI includes a toggle switch with a built-in abort controller. If the free Render backend is waking up from its 15-minute sleep cycle, users can cancel the live request and immediately browse precomputed data.

---

### Machine Learning Pipeline & Architecture

#### 1. Learning-to-Rank Objective (`XGBRanker`)
Unlike standard regression or classification models that predict discrete finishing numbers, the predictor uses **`XGBRanker`** configured with **`rank:pairwise`** or **LambdaMART (NDCG)** ranking objectives. Drivers in each Grand Prix are grouped by session (`qid`), teaching the model to rank drivers relative to one another rather than in isolation.

#### 2. Feature Engineering
The model trains and infers on 6 core features:

| Feature Name | Description |
| :--- | :--- |
| `driver_ewma` | Exponentially Weighted Moving Average ($\alpha = 0.56$) of the driver's recent finishing positions. Captures driver form. |
| `constructors_ewma` | Exponentially Weighted Moving Average of the team's combined finishing performance across recent rounds. Captures car performance. |
| `quali_relative_time` | Delta in milliseconds between a driver's fastest qualifying lap time and the pole position lap time. |
| `air_temp` | Ambient air temperature (°C) during the session. |
| `rainfall` | Rainfall indicator / fraction during the session. |
| `wind_speed` | Average wind speed (m/s) recorded across the session. |

---

### Backend API Endpoints (FastAPI)

The backend server is implemented in [`predictor/server.py`](predictor/server.py) and hosted on Render.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Health-check endpoint verifying API status. |
| `GET` | `/api/races` | Lists all historical and upcoming Grand Prix events available. |
| `GET` | `/api/predictions` | Returns the complete precomputed predictions document. |
| `GET` | `/api/predict` | Predicts standings for a specific race via `year`, `round`, or `session_key`. |
| `POST` | `/api/update_predictions` | Triggers a background recalculation and sync of new races. |
