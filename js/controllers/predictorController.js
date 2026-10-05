//------------------------------------------------------------
// PREDICTOR CONTROLLER — placeholder for your Python ML model hookup
// PREDICTOR CONTROLLER — Connects Python ML model to Web UI
//------------------------------------------------------------

// When you add your race winner predictor, wire it here:
// 1. Fetch or load model inputs (driver stats, circuit, weather, etc.)
// 2. Call your Python backend or pre-computed predictions JSON
// 3. Update the predictor view DOM with results
const API_BASE_URL = 'https://f1tele.onrender.com';
let allRacesData = [];
let isLiveApi = false;
let currentAbortController = null;
let useLocalMode = false; // toggle state

/**
 * Initializes the predictor page by setting up the toggle button 
 * and fetching the initial data (Live by default).
 */
export async function initPredictorPage() {
    setupToggleButton();
    await loadData();
}

/**
 * Sets up the event listener and initial state for the toggle button.
 */
function setupToggleButton() {
    const toggleBtn = document.getElementById('dataSourceToggleBtn');
    if (!toggleBtn) return;

    // Clone to remove old listeners
    const newToggleBtn = toggleBtn.cloneNode(true);
    toggleBtn.replaceWith(newToggleBtn);
    const activeBtn = document.getElementById('dataSourceToggleBtn');

    activeBtn.addEventListener('click', async () => {
        useLocalMode = !useLocalMode; // toggle state
        
        if (useLocalMode && currentAbortController) {
            // We are hanging on a live fetch, abort it!
            // The catch block in fetchLiveServer() will handle falling back to local.
            currentAbortController.abort(); 
        } else {
            // Re-fetch entirely (e.g., switching back to Live Server)
            allRacesData = null;
            await loadData();
        }
    });
}

/**
 * Updates the visual state of the toggle button based on useLocalMode
 */
function updateButtonUI() {
    const activeBtn = document.getElementById('dataSourceToggleBtn');
    if (!activeBtn) return;
    
    if (useLocalMode) {
        activeBtn.style.backgroundColor = 'var(--panel-line)';
        activeBtn.style.color = 'var(--text-dim)';
        activeBtn.style.border = '1px solid var(--panel-line)';
        activeBtn.textContent = 'FETCH FROM LIVE BACKEND';
    } else {
        activeBtn.style.backgroundColor = 'var(--red)';
        activeBtn.style.color = '#fff';
        activeBtn.style.border = '1px solid var(--red)';
        activeBtn.textContent = 'CANCEL & USE PRECOMPUTED';
    }
}

/**
 * Main coordinator to load data and update UI.
 */
async function loadData() {
    updateButtonUI();

    if (useLocalMode) {
        await fetchLocalData();
    } else {
        await fetchLiveServer();
    }

    // Update Status Tag
    const statusText = document.getElementById('predictorStatusText');
    if (statusText) {
        statusText.textContent = isLiveApi ? 'LIVE BACKEND SERVER' : 'LOCAL PRECOMPUTED VALUES';
        statusText.style.color = isLiveApi ? '#4cd964' : 'var(--amber)';
    }

    if (!allRacesData || allRacesData.length === 0) {
        console.error('No race prediction data available.');
        if (statusText) {
            statusText.textContent = 'Data Offline';
            statusText.style.color = 'var(--red)';
        }
        return;
    }

    const yearSelect = document.getElementById('predictorYearSelect');
    const raceSelect = document.getElementById('predictorRaceSelect');
    setupSelectors(yearSelect, raceSelect);
}

/**
 * Fetches data strictly from the Live API with Abort support.
 */
async function fetchLiveServer() {
    const loadingAlert = document.getElementById('backendLoadingAlert');
    if (loadingAlert) loadingAlert.hidden = false;
    
    currentAbortController = new AbortController();
    try {
        const apiRes = await fetch(`${API_BASE_URL}/api/predictions`, {
            signal: currentAbortController.signal
        });
        
        if (apiRes.ok) {
            const apiData = await apiRes.json();
            allRacesData = apiData.races || [];
            isLiveApi = true;
        } else {
            throw new Error("API returned non-200");
        }
    } catch (apiErr) {
        if (apiErr.name === 'AbortError') {
            console.log("Live API fetch was manually aborted by user. Falling back to local data.");
        } else {
            console.log("Live API not reachable, falling back to static JSON.", apiErr);
        }
        
        useLocalMode = true;
        updateButtonUI();
        await fetchLocalData();
    } finally {
        // when fetch is complete
        currentAbortController = null; 
    }
    if(loadingAlert) loadingAlert.hidden = true;
}

/**
 * Fetches data strictly from the precomputed JSON.
 */
async function fetchLocalData() {
    try {
        const staticRes = await fetch('predictions.json');
        if (!staticRes.ok) {
            const fallbackRes = await fetch('predictor/predictions.json');
            const fallbackData = await fallbackRes.json();
            allRacesData = fallbackData.races || [];
        } else {
            const staticData = await staticRes.json();
            allRacesData = staticData.races || [];
        }
        isLiveApi = false;
    } catch (err) {
        console.error("Failed to load local static JSON", err);
        allRacesData = [];
        isLiveApi = false;
    }
}

/**
 * Populates year and race dropdowns and wires change events.
 */
function setupSelectors(yearSelect, raceSelect) {
    if (!yearSelect || !raceSelect) return;

    // Extract unique years sorted descending
    const years = [...new Set(allRacesData.map(r => r.year))].sort((a, b) => b - a);

    yearSelect.innerHTML = '';
    years.forEach(year => {
        const opt = document.createElement('option');
        opt.value = year;
        opt.textContent = year;
        yearSelect.appendChild(opt);
    });

    const populateRacesForYear = (selectedYear) => {
        const racesInYear = allRacesData.filter(r => r.year === parseInt(selectedYear, 10));
        raceSelect.innerHTML = '';

        racesInYear.forEach(race => {
            const opt = document.createElement('option');
            opt.value = race.session_key;
            opt.textContent = `Round ${race.round}: ${race.race_name}`;
            raceSelect.appendChild(opt);
        });

        if (racesInYear.length > 0) {
            renderRaceStandings(racesInYear[0]);
        }
    };

    // Initial population
    if (years.length > 0) {
        populateRacesForYear(years[0]);
    }

    yearSelect.addEventListener('change', (e) => {
        populateRacesForYear(e.target.value);
    });

    raceSelect.addEventListener('change', (e) => {
        const sessionKey = parseInt(e.target.value, 10);
        const selectedRace = allRacesData.find(r => r.session_key === sessionKey);
        if (selectedRace) {
            renderRaceStandings(selectedRace);
        }
    });
}

/**
 * Renders the race metadata card, podium cards, and full standings table.
 */
function renderRaceStandings(race) {
    const metaCard = document.getElementById('raceMetaCard');
    const raceTitle = document.getElementById('raceTitle');
    const raceCircuit = document.getElementById('raceCircuit');
    const raceWeather = document.getElementById('raceWeather');
    const podiumGrid = document.getElementById('podiumGrid');
    const tableBody = document.getElementById('standingsTableBody');

    if (metaCard) metaCard.style.display = 'flex';
    if (raceTitle) raceTitle.textContent = `${race.year} ${race.race_name} (Round ${race.round})`;
    if (raceCircuit) raceCircuit.textContent = `Circuit: ${race.circuit} · Session Key: ${race.session_key}`;

    // Weather pills
    if (raceWeather && race.weather) {
        raceWeather.innerHTML = `
            <span class="weather-pill">
                <span class="weather-pill__label">AIR TEMP</span>
                ${race.weather.air_temp}°C
            </span>
            <span class="weather-pill">
                <span class="weather-pill__label">RAIN</span>
                ${race.weather.rainfall_pct}%
            </span>
            <span class="weather-pill">
                <span class="weather-pill__label">WIND</span>
                ${race.weather.wind_speed} m/s
            </span>
        `;
    }

    const standings = race.standings || [];

    // Render Podium Top 3 Cards
    if (podiumGrid) {
        podiumGrid.innerHTML = '';
        const top3 = standings.slice(0, 3);
        const rankLabels = ['p1', 'p2', 'p3'];

        top3.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = `podium-card podium-card--${rankLabels[index]}`;
            card.innerHTML = `
                <div class="podium-card__rank">P${item.predicted_position}</div>
                <h4 class="podium-card__name">${escapeHtml(item.full_name)} (${escapeHtml(item.abbreviation)})</h4>
                <div class="podium-card__team">${escapeHtml(formatTeamName(item.team_id))}</div>
                <div class="podium-card__score">Relevance Score: <strong>${item.prediction_score.toFixed(4)}</strong></div>
            `;
            podiumGrid.appendChild(card);
        });
    }

    // Render Full Standings Table
    if (tableBody) {
        tableBody.innerHTML = '';

        standings.forEach(item => {
            const tr = document.createElement('tr');

            // Pos badge
            let posClass = 'pos-tag--default';
            if (item.predicted_position === 1) posClass = 'pos-tag--p1';
            else if (item.predicted_position === 2) posClass = 'pos-tag--p2';
            else if (item.predicted_position === 3) posClass = 'pos-tag--p3';

            // Actual position & Delta
            const actualStr = item.actual_position ? `P${item.actual_position}` : '—';
            let deltaHtml = '<span class="delta-tag delta-tag--far">—</span>';

            if (item.accuracy_delta !== null && item.accuracy_delta !== undefined) {
                if (item.accuracy_delta === 0) {
                    deltaHtml = '<span class="delta-tag delta-tag--exact">🎯 Match</span>';
                } else if (Math.abs(item.accuracy_delta) <= 2) {
                    const sign = item.accuracy_delta > 0 ? '+' : '';
                    deltaHtml = `<span class="delta-tag delta-tag--close">${sign}${item.accuracy_delta} pos</span>`;
                } else {
                    const sign = item.accuracy_delta > 0 ? '+' : '';
                    deltaHtml = `<span class="delta-tag delta-tag--far">${sign}${item.accuracy_delta} pos</span>`;
                }
            }

            // Quali delta
            const qualiDeltaStr = item.quali_time_ms > 0 ? `+${(item.quali_time_ms / 1000).toFixed(3)}s` : '0.000s';

            tr.innerHTML = `
                <td style="text-align: left;"><span class="pos-tag ${posClass}">P${item.predicted_position}</span></td>
                <td style="text-align: left; font-weight: 700;">${escapeHtml(item.full_name)} <span style="color: var(--text-dim); font-size: 0.75rem;">${escapeHtml(item.abbreviation)}</span></td>
                <td style="text-align: left; color: var(--text-dim);">${escapeHtml(formatTeamName(item.team_id))}</td>
                <td style="color: var(--amber); font-family: var(--font-mono);">${item.prediction_score.toFixed(4)}</td>
                <td style="font-weight: 700;">${actualStr}</td>
                <td>${deltaHtml}</td>
                <td style="color: var(--text-dim); font-size: 0.75rem;">${qualiDeltaStr}</td>
                <td style="font-size: 0.75rem;">${item.driver_points}</td>
            `;

            tableBody.appendChild(tr);
        });
    }
}

function formatTeamName(teamId) {
    if (!teamId) return '';
    if (teamId.toLowerCase() === 'rb') return 'VCARB';
    return teamId
        .replace(/_/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());
}

function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}