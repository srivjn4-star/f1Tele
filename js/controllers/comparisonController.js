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
import { renderLapsTable } from '../view/lapsTableView.js';
import { renderReadoutCardShell, updateReadout } from '../view/readoutView.js';
import { destroyChart, renderChart } from '../view/chartView.js';
import {
    createCoordinateMapper,
    findBestReferenceLap,
    flattenLapData,
    buildLapStartIndex,
    findNearestLocalIndex,
    findNearestByTime,
    findNearestCarDataPoint,
    getRaceProgress,
    renderTrack
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
// CLEAR VIEW — reset chart, track, tables when session changes
//------------------------------------------------------------

function clearComparisonView() {
    destroyChart();
    state.carState = null;
    lapSelect.innerHTML = "";
    document.getElementById('trackContainer').innerHTML = "";
    document.getElementById('driverAReadout').innerHTML = "";
    document.getElementById('driverBReadout').innerHTML = "";
    document.getElementById('driverATable').innerHTML = "";
    document.getElementById('driverBTable').innerHTML = "";
    document.getElementById('driverATableName').textContent = "Driver A";
    document.getElementById('driverBTableName').textContent = "Driver B";
    document.getElementById('driverADot').style.background = "";
    document.getElementById('driverBDot').style.background = "";
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

//------------------------------------------------------------
// DRAGGING — sync both cars by timestamp on the track map
//------------------------------------------------------------

function moveCarTo(car, sessionIndex) {
    car.sessionIndex = sessionIndex;
    const point = car.sessionArray[sessionIndex];
    document.getElementById(car.circleId).setAttribute('cx', point.pixelX);
    document.getElementById(car.circleId).setAttribute('cy', point.pixelY);
    const carDataPoint = findNearestCarDataPoint(car.carData[point.lapIndex], point.date);
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

        const rect = svg.getBoundingClientRect();
        const scaleX = svg.viewBox.baseVal.width / rect.width;
        const scaleY = svg.viewBox.baseVal.height / rect.height;
        const mouseX = (e.clientX - rect.left) * scaleX;
        const mouseY = (e.clientY - rect.top) * scaleY;

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
            renderChart(leadLapIndex);
        }
    });
}

//------------------------------------------------------------
// LOAD COMPARISON — runs once per "Load Comparison" click
//------------------------------------------------------------

async function buildDriverState(driverNumber, circleId, readoutId, tableId, tableNameId, dotId) {
    const info = findDriverInfo(driverNumber);
    const color = `#${info.team_colour}`;
    const laps = await getLaps(driverNumber);

    document.getElementById(tableNameId).textContent = info.full_name;
    document.getElementById(dotId).style.background = color;
    renderLapsTable(laps, document.getElementById(tableId));

    const carData = await carDataReadyForChart(driverNumber, laps);
    const locationData = await carLocationDataReadyForChart(driverNumber, laps);

    return { number: driverNumber, info, color, laps, carData, locationData, circleId, readoutId };
}

async function loadComparison(driverNumA, driverNumB) {
    const a = await buildDriverState(driverNumA, 'driverACarMarker', 'driverAReadout', 'driverATable', 'driverATableName', 'driverADot');
    const b = await buildDriverState(driverNumB, 'driverBCarMarker', 'driverBReadout', 'driverBTable', 'driverBTableName', 'driverBDot');

    state.carState = { a, b };

    lapSelect.innerHTML = "";
    a.laps.forEach((lap, index) => {
        const option = document.createElement('option');
        option.value = index;
        option.textContent = `Lap ${lap.lap_number}`;
        lapSelect.appendChild(option);
    });
    renderChart(0);

    const referenceLap = findBestReferenceLap(a.laps, a.locationData, b.laps, b.locationData);
    const toPixel = createCoordinateMapper(referenceLap.points, 800, 500);
    const trackPoints = referenceLap.points.map(p => ({ ...p, ...toPixel(p) }));

    a.sessionArray = flattenLapData(a.locationData).map(p => ({ ...p, ...toPixel(p) }));
    b.sessionArray = flattenLapData(b.locationData).map(p => ({ ...p, ...toPixel(p) }));
    a.sessionIndex = 0;
    b.sessionIndex = 0;
    const aLapStarts = buildLapStartIndex(a.sessionArray);
    const bLapStarts = buildLapStartIndex(b.sessionArray);

    const aStartIndex = aLapStarts.find(idx => idx !== undefined);
    const bStartIndex = bLapStarts.find(idx => idx !== undefined);
    const aStartPixel = a.sessionArray[aStartIndex];
    const bStartPixel = b.sessionArray[bStartIndex];

    renderTrack('trackContainer', trackPoints, aStartPixel, bStartPixel, referenceLap.lap);
    renderReadoutCardShell(a);
    renderReadoutCardShell(b);

    makeDraggable(a, b);
    makeDraggable(b, a);

    lapSelect.onchange = () => {
        const lapIndex = Number(lapSelect.value);
        renderChart(lapIndex);

        const aLapStartTime = a.laps[lapIndex] ? new Date(a.laps[lapIndex].date_start).getTime() : Infinity;
        const bLapStartTime = b.laps[lapIndex] ? new Date(b.laps[lapIndex].date_start).getTime() : Infinity;

        if (aLapStartTime <= bLapStartTime && aLapStarts[lapIndex] !== undefined) {
            moveCarTo(a, aLapStarts[lapIndex]);
            moveCarTo(b, findNearestByTime(b.sessionArray, aLapStartTime));
        } else if (bLapStarts[lapIndex] !== undefined) {
            moveCarTo(b, bLapStarts[lapIndex]);
            moveCarTo(a, findNearestByTime(a.sessionArray, bLapStartTime));
        }
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
        loadComparison(numA, numB).finally(() => {
            loadComparisonBtn.textContent = "Load Comparison";
            validateDriverSelection();
        });
    });
}
