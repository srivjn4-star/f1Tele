//------------------------------------------------------------
// COMPARISON CONTROLLER — wires model + views for the comparison page
//------------------------------------------------------------

import { state } from '../model/state.js';
import {
    loadSessionsDirectory,
    setSessionKey,
    getCircuitImageUrl,
    fetchDriversForSession,
    refreshUniqueDrivers,
    findDriverInfo
} from '../model/sessionModel.js';
import {
    getLaps,
    carDataReadyForChart,
    carLocationDataReadyForChart
} from '../model/telemetryModel.js';
import {
    populateYearSelect,
    populateCircuitSelect,
    populateDriverSelect,
    updateSessionSubhead,
    renderCircuitImage
} from '../view/selectorView.js';
import {
    hideAllSessionAlerts,
    updateAlertsForSession,
    wireAlertCloseButtons
} from '../view/alertView.js';
import { renderReadoutCardShell, updateReadout } from '../view/readoutView.js';
import { destroyCharts, renderCharts, updateChartCursors, clearChartOverlays } from '../view/chartView.js';
import {
    createCoordinateMapper,
    findBestReferenceLap,
    flattenLapData,
    buildLapStartIndex,
    findNearestLocalIndex,
    findNearestByTime,
    findNearestCarDataPoint,
    getRaceProgress,
    renderTrack,
    renderScrubberWidget,
    updateScrubberActiveDriver,
    updateScrubberKnob,
    getScrubberProgressFromMouse
} from '../view/trackView.js';

let yearSelect;
let circuitSelect;
let sessionSubhead;
let driverASelect;
let driverBSelect;
let loadComparisonBtn;
let driverSelectWarning;
let lapSelect;

//------------------------------------------------------------
// CLEAR VIEW — reset chart, track, readouts when session changes
//------------------------------------------------------------

function clearComparisonView() {
    destroyCharts();
    state.carState = null;
    lapSelect.innerHTML = "";
    document.getElementById('trackContainer').innerHTML = "";
    const scrubberSlot = document.getElementById('scrubberSlot');
    if (scrubberSlot) scrubberSlot.innerHTML = "";
    document.getElementById('driverAReadout').innerHTML = "";
    document.getElementById('driverBReadout').innerHTML = "";
}

function repopulateDriverSelects() {
    populateDriverSelect(driverASelect);
    populateDriverSelect(driverBSelect);
    if (state.uniqueDrivers.length > 1) {
        driverASelect.value = state.uniqueDrivers[0].driver_number;
        driverBSelect.value = state.uniqueDrivers[1].driver_number;
    }
    validateDriverSelection();
}

function validateDriverSelection() {
    const same = driverASelect.value !== "" && driverASelect.value === driverBSelect.value;
    const noDrivers = state.uniqueDrivers.length < 2;
    loadComparisonBtn.disabled = same || noDrivers || driverASelect.value === "" || driverBSelect.value === "";
    driverSelectWarning.textContent = noDrivers
        ? "Need at least two drivers in this session."
        : same ? "Pick two different drivers." : "";
}

async function refreshCircuitImage() {
    if (!state.sessionKey) {
        renderCircuitImage('circuitImageContainer', null);
        return;
    }
    const imageUrl = await getCircuitImageUrl(state.sessionKey);
    renderCircuitImage('circuitImageContainer', imageUrl, state.currentSession?.circuit_short_name);
}

async function loadSessionForSelection() {
    const year = Number(yearSelect.value);
    const circuit = circuitSelect.value;
    if (!year || !circuit) return;

    clearComparisonView();
    hideAllSessionAlerts();
    driverASelect.disabled = true;
    driverBSelect.disabled = true;
    loadComparisonBtn.disabled = true;
    sessionSubhead.textContent = "Loading session...";

    await setSessionKey(year, circuit);
    updateSessionSubhead(sessionSubhead);
    updateAlertsForSession();

    const sessionDrivers = await fetchDriversForSession();
    refreshUniqueDrivers(sessionDrivers);
    repopulateDriverSelects();

    await refreshCircuitImage();

    driverASelect.disabled = false;
    driverBSelect.disabled = false;
}

function onYearChange() {
    populateCircuitSelect(circuitSelect, Number(yearSelect.value));
    loadSessionForSelection();
}

let activeScrubberDriver = 'a';
let lastScrubberT = null;

function syncScrubberKnobFromActiveCar() {
    if (!state.carState) return;
    const activeCar = state.carState[activeScrubberDriver];
    if (!activeCar || !activeCar.sessionArray || activeCar.sessionIndex === undefined) return;
    const curPoint = activeCar.sessionArray[activeCar.sessionIndex];
    if (!curPoint) return;
    const start = activeCar.lapStarts && activeCar.lapStarts[curPoint.lapIndex] !== undefined ? activeCar.lapStarts[curPoint.lapIndex] : 0;
    const next = activeCar.lapStarts && activeCar.lapStarts[curPoint.lapIndex + 1] !== undefined ? activeCar.lapStarts[curPoint.lapIndex + 1] : activeCar.sessionArray.length;
    const len = Math.max(1, next - start);
    const t = Math.max(0, Math.min(1, (activeCar.sessionIndex - start) / Math.max(1, len - 1)));
    updateScrubberKnob(t, activeCar.color);
}

function initScrubberLoopInteractions() {
    const btnA = document.getElementById('scrubberDriverABtn');
    const btnB = document.getElementById('scrubberDriverBBtn');
    const svg = document.getElementById('scrubberSvg');
    if (!btnA || !btnB || !svg) return;

    btnA.onclick = (e) => {
        e.stopPropagation();
        activeScrubberDriver = 'a';
        lastScrubberT = null;
        updateScrubberActiveDriver('a', state.carState.a.color, state.carState.b.color);
        syncScrubberKnobFromActiveCar();
    };

    btnB.onclick = (e) => {
        e.stopPropagation();
        activeScrubberDriver = 'b';
        lastScrubberT = null;
        updateScrubberActiveDriver('b', state.carState.a.color, state.carState.b.color);
        syncScrubberKnobFromActiveCar();
    };

    let scrubbing = false;

    function handleScrub(e, isInitial = false) {
        if (!state.carState) return;
        const rect = svg.getBoundingClientRect();
        const mouseX = (e.clientX - rect.left) * (200 / rect.width);
        const mouseY = (e.clientY - rect.top) * (52 / rect.height);
        const t = getScrubberProgressFromMouse(mouseX, mouseY);

        const activeCar = state.carState[activeScrubberDriver];
        const otherCar = state.carState[activeScrubberDriver === 'a' ? 'b' : 'a'];
        let lapIndex = Number(lapSelect.value);

        // Detect lap completion when scrubbing around the loop
        if (!isInitial && lastScrubberT !== null) {
            if (lastScrubberT > 0.75 && t < 0.25) {
                // Completed lap forward (clockwise)
                if (lapIndex < activeCar.laps.length - 1) {
                    lapIndex++;
                    lapSelect.value = lapIndex;
                    renderCharts(lapIndex);
                }
            } else if (lastScrubberT < 0.25 && t > 0.75) {
                // Scrubbed backward (counter-clockwise)
                if (lapIndex > 0) {
                    lapIndex--;
                    lapSelect.value = lapIndex;
                    renderCharts(lapIndex);
                }
            }
        }
        lastScrubberT = t;

        const start = activeCar.lapStarts && activeCar.lapStarts[lapIndex] !== undefined ? activeCar.lapStarts[lapIndex] : 0;
        const next = activeCar.lapStarts && activeCar.lapStarts[lapIndex + 1] !== undefined ? activeCar.lapStarts[lapIndex + 1] : activeCar.sessionArray.length;
        const lapLen = Math.max(1, next - start);
        const targetIndex = Math.min(next - 1, start + Math.round(t * (lapLen - 1)));

        const point = moveCarTo(activeCar, targetIndex);
        const otherIndex = findNearestByTime(otherCar.sessionArray, new Date(point.date).getTime());
        moveCarTo(otherCar, otherIndex);

        updateChartCursors(state.carState.a.currentCarDataPoint, state.carState.b.currentCarDataPoint);
        updateScrubberKnob(t, activeCar.color);
    }

    svg.addEventListener('mousedown', (e) => {
        scrubbing = true;
        handleScrub(e, true);
    });
    window.addEventListener('mouseup', () => {
        scrubbing = false;
        lastScrubberT = null;
    });
    window.addEventListener('mousemove', (e) => {
        if (scrubbing) handleScrub(e, false);
    });
}

function initChartTabBars() {
    document.querySelectorAll('.chart-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.target;
            const targetEl = document.getElementById(targetId);
            const scrollBox = document.getElementById('chartsScrollBox');
            if (targetEl && scrollBox) {
                targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
            document.querySelectorAll('.chart-tab-btn').forEach(b => b.classList.remove('chart-tab-btn--active'));
            btn.classList.add('chart-tab-btn--active');
        });
    });
}

//------------------------------------------------------------
// DRAGGING — sync both cars by timestamp on the track map
//------------------------------------------------------------

function moveCarTo(car, sessionIndex) {
    car.sessionIndex = sessionIndex;
    const point = car.sessionArray[sessionIndex];
    document.getElementById(car.circleId).setAttribute('cx', point.pixelX);
    document.getElementById(car.circleId).setAttribute('cy', point.pixelY);
    const carDataPoint = findNearestCarDataPoint(car.carData[point.lapIndex], point.date);
    car.currentCarDataPoint = carDataPoint;
    updateReadout(car, carDataPoint);
    return point;
}

function makeDraggable(car, otherCar) {
    const circle = document.getElementById(car.circleId);
    const svg = circle.ownerSVGElement;
    let dragging = false;

    circle.addEventListener('mousedown', () => { dragging = true; });
    window.addEventListener('mouseup', () => { dragging = false; });

    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;

        let mouseX, mouseY;
        const ctm = svg.getScreenCTM();
        if (ctm && svg.createSVGPoint) {
            const pt = svg.createSVGPoint();
            pt.x = e.clientX;
            pt.y = e.clientY;
            const svgPt = pt.matrixTransform(ctm.inverse());
            mouseX = svgPt.x;
            mouseY = svgPt.y;
        } else {
            const rect = svg.getBoundingClientRect();
            mouseX = (e.clientX - rect.left) * (svg.viewBox.baseVal.width / rect.width);
            mouseY = (e.clientY - rect.top) * (svg.viewBox.baseVal.height / rect.height);
        }

        const newIndex = findNearestLocalIndex(car.sessionArray, car.sessionIndex, mouseX, mouseY);
        const point = moveCarTo(car, newIndex);

        const targetTime = new Date(point.date).getTime();
        const otherIndex = findNearestByTime(otherCar.sessionArray, targetTime);
        const pointOther = moveCarTo(otherCar, otherIndex);

        const progressThis = getRaceProgress(point, car.laps);
        const progressOther = getRaceProgress(pointOther, otherCar.laps);
        const leadLapIndex = progressThis > progressOther ? point.lapIndex : pointOther.lapIndex;
        if (Number(lapSelect.value) !== leadLapIndex) {
            lapSelect.value = leadLapIndex;
            renderCharts(leadLapIndex);
        }

        updateChartCursors(state.carState.a.currentCarDataPoint, state.carState.b.currentCarDataPoint);
        syncScrubberKnobFromActiveCar();
    });
}

//------------------------------------------------------------
// LOAD COMPARISON — runs once per "Load Comparison" click
//------------------------------------------------------------

async function buildDriverState(driverNumber, circleId, readoutId) {
    const info = findDriverInfo(driverNumber);
    const color = `#${info.team_colour}`;
    const laps = await getLaps(driverNumber);

    const carData = await carDataReadyForChart(driverNumber, laps);
    const locationData = await carLocationDataReadyForChart(driverNumber, laps);

    return { number: driverNumber, info, color, laps, carData, locationData, circleId, readoutId };
}

async function loadComparison(driverNumA, driverNumB) {
    const a = await buildDriverState(driverNumA, 'driverACarMarker', 'driverAReadout');
    const b = await buildDriverState(driverNumB, 'driverBCarMarker', 'driverBReadout');

    state.carState = { a, b };

    lapSelect.innerHTML = "";
    a.laps.forEach((lap, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `Lap ${lap.lap_number}`;
        lapSelect.appendChild(option);
    });
    renderCharts(0);

    const referenceLap = findBestReferenceLap(a.laps, a.locationData, b.laps, b.locationData);
    const toPixel = createCoordinateMapper(referenceLap.points, 800, 500);
    const trackPoints = referenceLap.points.map(p => ({ ...p, ...toPixel(p) }));

    a.sessionArray = flattenLapData(a.locationData).map(p => ({ ...p, ...toPixel(p) }));
    b.sessionArray = flattenLapData(b.locationData).map(p => ({ ...p, ...toPixel(p) }));
    a.sessionIndex = 0;
    b.sessionIndex = 0;
    const aLapStarts = buildLapStartIndex(a.sessionArray);
    const bLapStarts = buildLapStartIndex(b.sessionArray);
    a.lapStarts = aLapStarts;
    b.lapStarts = bLapStarts;

    const aStartIndex = aLapStarts.find(idx => idx !== undefined);
    const bStartIndex = bLapStarts.find(idx => idx !== undefined);
    const aStartPixel = a.sessionArray[aStartIndex];
    const bStartPixel = b.sessionArray[bStartIndex];

    renderTrack('trackContainer', trackPoints, aStartPixel, bStartPixel, referenceLap.lap);
    renderScrubberWidget('scrubberSlot', a, b, activeScrubberDriver);
    initScrubberLoopInteractions();

    renderReadoutCardShell(a);
    renderReadoutCardShell(b);

    if (aStartIndex !== undefined) moveCarTo(a, aStartIndex);
    if (bStartIndex !== undefined) moveCarTo(b, bStartIndex);
    updateChartCursors(a.currentCarDataPoint, b.currentCarDataPoint);
    syncScrubberKnobFromActiveCar();

    makeDraggable(a, b);
    makeDraggable(b, a);

    lapSelect.onchange = () => {
        const lapIndex = Number(lapSelect.value);
        lastScrubberT = null;
        renderCharts(lapIndex);

        const aLapStartTime = a.laps[lapIndex] ? new Date(a.laps[lapIndex].date_start).getTime() : Infinity;
        const bLapStartTime = b.laps[lapIndex] ? new Date(b.laps[lapIndex].date_start).getTime() : Infinity;

        if (aLapStartTime <= bLapStartTime && aLapStarts[lapIndex] !== undefined) {
            moveCarTo(a, aLapStarts[lapIndex]);
            moveCarTo(b, findNearestByTime(b.sessionArray, aLapStartTime));
        } else if (bLapStarts[lapIndex] !== undefined) {
            moveCarTo(b, bLapStarts[lapIndex]);
            moveCarTo(a, findNearestByTime(a.sessionArray, bLapStartTime));
        }
        updateChartCursors(a.currentCarDataPoint, b.currentCarDataPoint);
        syncScrubberKnobFromActiveCar();
    };
}

//------------------------------------------------------------
// INIT — bootstrap the comparison page
//------------------------------------------------------------

export async function initComparisonPage() {
    yearSelect = document.getElementById('yearSelect');
    circuitSelect = document.getElementById('circuitSelect');
    sessionSubhead = document.getElementById('sessionSubhead');
    driverASelect = document.getElementById('driverASelect');
    driverBSelect = document.getElementById('driverBSelect');
    loadComparisonBtn = document.getElementById('loadComparisonBtn');
    driverSelectWarning = document.getElementById('driverSelectWarning');
    lapSelect = document.getElementById('lapSelect');

    wireAlertCloseButtons();
    initChartTabBars();

    await loadSessionsDirectory();

    populateYearSelect(yearSelect);
    if (state.years.length > 0) {
        yearSelect.value = state.years[0];
        populateCircuitSelect(circuitSelect, state.years[0]);
        if (state.circuitsByYear[state.years[0]]?.length > 0) {
            circuitSelect.value = state.circuitsByYear[state.years[0]][0].circuit_short_name;
            await loadSessionForSelection();
        }
    }

    yearSelect.addEventListener('change', onYearChange);
    circuitSelect.addEventListener('change', () => loadSessionForSelection());

    driverASelect.addEventListener('change', validateDriverSelection);
    driverBSelect.addEventListener('change', validateDriverSelection);

    loadComparisonBtn.addEventListener('click', () => {
        const numA = Number(driverASelect.value);
        const numB = Number(driverBSelect.value);
        loadComparisonBtn.disabled = true;
        loadComparisonBtn.textContent = "Loading...";
        loadComparison(numA, numB).catch(err => {
            console.error("Comparison load error:", err);
            
            if (err.message && err.message.includes("429")) {
                const alertEl = document.getElementById('openf1RateLimitAlert');
                if (alertEl) alertEl.hidden = false;
            } else if (state.currentSession?.date_start && state.currentSession?.date_end) {
                const now = Date.now();
                const startMs = new Date(state.currentSession.date_start).getTime();
                const endMs = new Date(state.currentSession.date_end).getTime();
                if (now >= startMs && now < endMs) {
                    const alertEl = document.getElementById('openf1LiveSessionAlert');
                    if (alertEl) alertEl.hidden = false;
                }
            }
        }).finally(() => {
            loadComparisonBtn.textContent = "Load Comparison";
            validateDriverSelection();
        });
    });
}
