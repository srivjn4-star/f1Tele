//------------------------------------------------------------
// CHART VIEW — speed, throttle, and brake swimlane charts + overlay cursors
//------------------------------------------------------------

import { state } from '../model/state.js';

// ============================================================
// 1. CHART THEME CONFIGURATION
// ============================================================

const CHART_FONTS = {
    mono: { family: "'Consolas', monospace", size: 10 },
    monoTitle: { family: "'Consolas', monospace", size: 11 }
};

const CHART_COLORS = {
    grid: '#1a1a20',
    axisText: '#8a8a90',
    panelBg: '#111114',
    panelBorder: '#1e1e24',
    text: '#e8e8e8',
    swimlaneBaseline: '#262630'
};

const COMMON_PLUGINS = {
    legend: {
        display: true,
        position: 'top',
        align: 'end',
        labels: {
            color: CHART_COLORS.axisText,
            boxWidth: 10,
            boxHeight: 10,
            usePointStyle: true,
            font: CHART_FONTS.mono
        }
    },
    tooltip: {
        backgroundColor: CHART_COLORS.panelBg,
        titleColor: CHART_COLORS.text,
        bodyColor: CHART_COLORS.text,
        borderColor: CHART_COLORS.panelBorder,
        borderWidth: 1,
        titleFont: CHART_FONTS.mono,
        bodyFont: CHART_FONTS.mono
    }
};

function createLinearScale(titleText, minY = null, maxY = null) {
    return {
        type: 'linear',
        title: { display: Boolean(titleText), text: titleText, color: CHART_COLORS.axisText, font: CHART_FONTS.mono },
        grid: { color: CHART_COLORS.grid },
        ticks: { color: CHART_COLORS.axisText, font: CHART_FONTS.mono },
        min: minY !== null ? minY : undefined,
        max: maxY !== null ? maxY : undefined
    };
}

function createLineChartConfig(titleY, datasetA, datasetB, minY = null, maxY = null) {
    return {
        type: 'line',
        data: {
            datasets: [datasetA, datasetB]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: COMMON_PLUGINS,
            scales: {
                x: createLinearScale('Elapsed time (s)'),
                y: createLinearScale(titleY, minY, maxY)
            }
        }
    };
}

// ============================================================
// 2. DATA UTILITIES
// ============================================================

function normalizeBrake(val) {
    if (val === true || val === 1) return 100;
    const num = Number(val);
    return isNaN(num) ? 0 : (num > 1 ? num : num * 100);
}

function extractBrakeIntervals(carLapData) {
    const intervals = [];
    let inBrake = false;
    let startSec = 0;

    for (let i = 0; i < carLapData.length; i++) {
        const pt = carLapData[i];
        const isBraking = pt.brake === true || pt.brake === 1 || Number(pt.brake) > 0;

        if (isBraking && !inBrake) {
            inBrake = true;
            startSec = pt.elapsedSeconds;
        } else if (!isBraking && inBrake) {
            inBrake = false;
            intervals.push([startSec, pt.elapsedSeconds]);
        }
    }
    if (inBrake && carLapData.length > 0) {
        intervals.push([startSec, carLapData[carLapData.length - 1].elapsedSeconds]);
    }
    return intervals;
}

// ============================================================
// 3. CHART BUILDERS
// ============================================================

function buildLineDataset(driver, dataPoints, valueKey) {
    return {
        label: driver.info.full_name,
        data: dataPoints.map(p => ({ x: p.elapsedSeconds, y: p[valueKey] })),
        borderColor: driver.color,
        borderWidth: 1.5,
        fill: false,
        pointRadius: 0
    };
}

function createSpeedChart(canvasEl, driverA, aData, driverB, bData) {
    if (!canvasEl) return null;
    return new Chart(canvasEl, createLineChartConfig(
        'Speed (km/h)',
        buildLineDataset(driverA, aData, 'speed'),
        buildLineDataset(driverB, bData, 'speed')
    ));
}

function createThrottleChart(canvasEl, driverA, aData, driverB, bData) {
    if (!canvasEl) return null;
    return new Chart(canvasEl, createLineChartConfig(
        'Throttle (%)',
        buildLineDataset(driverA, aData, 'throttle'),
        buildLineDataset(driverB, bData, 'throttle'),
        0,
        105
    ));
}

function createSwimlaneGuidelinePlugin(driverNames) {
    return {
        id: 'swimlaneTrackLines',
        beforeDatasetsDraw(chart) {
            const { ctx, chartArea, scales } = chart;
            if (!chartArea || !scales.y) return;
            const yAxis = scales.y;

            ctx.save();
            ctx.strokeStyle = CHART_COLORS.swimlaneBaseline;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);

            driverNames.forEach(name => {
                const y = yAxis.getPixelForValue(name);
                if (y !== undefined && !isNaN(y)) {
                    ctx.beginPath();
                    ctx.moveTo(chartArea.left, y);
                    ctx.lineTo(chartArea.right, y);
                    ctx.stroke();
                }
            });

            ctx.restore();
        }
    };
}

function createBrakeChart(canvasEl, driverA, aData, driverB, bData) {
    if (!canvasEl) return null;

    const intervalsA = extractBrakeIntervals(aData);
    const intervalsB = extractBrakeIntervals(bData);
    const nameA = driverA.info.full_name;
    const nameB = driverB.info.full_name;
    const maxTime = Math.max(
        aData.length ? aData[aData.length - 1].elapsedSeconds : 60,
        bData.length ? bData[bData.length - 1].elapsedSeconds : 60
    );

    return new Chart(canvasEl, {
        type: 'bar',
        data: {
            labels: [nameB, nameA],
            datasets: [
                {
                    label: nameA,
                    data: intervalsA.map(range => ({ x: range, y: nameA })),
                    backgroundColor: driverA.color,
                    borderColor: driverA.color,
                    borderRadius: 4,
                    barThickness: 16
                },
                {
                    label: nameB,
                    data: intervalsB.map(range => ({ x: range, y: nameB })),
                    backgroundColor: driverB.color,
                    borderColor: driverB.color,
                    borderRadius: 4,
                    barThickness: 16
                }
            ]
        },
        plugins: [createSwimlaneGuidelinePlugin([nameA, nameB])],
        options: {
            indexAxis: 'y',
            grouped: false,
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            plugins: {
                ...COMMON_PLUGINS,
                tooltip: {
                    ...COMMON_PLUGINS.tooltip,
                    callbacks: {
                        label: (ctx) => {
                            const range = ctx.raw?.x;
                            if (Array.isArray(range)) {
                                const duration = (range[1] - range[0]).toFixed(2);
                                return `${ctx.dataset.label}: Braking ${range[0].toFixed(1)}s - ${range[1].toFixed(1)}s (${duration}s)`;
                            }
                            return '';
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'linear',
                    min: 0,
                    max: maxTime,
                    title: { display: true, text: 'Elapsed time (s)', color: CHART_COLORS.axisText, font: CHART_FONTS.mono },
                    grid: { color: CHART_COLORS.grid },
                    ticks: { color: CHART_COLORS.axisText, font: CHART_FONTS.mono }
                },
                y: {
                    grid: { color: CHART_COLORS.grid },
                    ticks: { color: CHART_COLORS.text, font: CHART_FONTS.monoTitle }
                }
            }
        }
    });
}

// ============================================================
// 4. OVERLAY CURSOR DRAWING HELPERS
// ============================================================

function prepareOverlayCanvas(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);

    if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.resetTransform ? ctx.resetTransform() : ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);
    return ctx;
}

function drawVerticalGuide(ctx, x, top, bottom, color) {
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
}

function drawPointMarker(ctx, x, y, color, outerR = 4.5, innerR = 2) {
    ctx.save();
    ctx.beginPath();
    ctx.fillStyle = color;
    ctx.arc(x, y, outerR, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.fillStyle = '#ffffff';
    ctx.arc(x, y, innerR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function renderDriverCursor(ctx, chartArea, scales, point, color, val, isSwimlane, driverName) {
    if (!point || point.elapsedSeconds === undefined) return;
    const { left, right, top, bottom } = chartArea;
    const x = scales.x.getPixelForValue(point.elapsedSeconds);
    if (x < left || x > right) return;

    drawVerticalGuide(ctx, x, top, bottom, color);

    if (isSwimlane) {
        if (val > 0) {
            const rowY = scales.y.getPixelForValue(driverName);
            if (rowY !== undefined && !isNaN(rowY)) {
                drawPointMarker(ctx, x, rowY, color, 5, 2.5);
            }
        }
    } else {
        if (val !== undefined && val !== null && !isNaN(val)) {
            const y = Math.min(Math.max(scales.y.getPixelForValue(val), top), bottom);
            drawPointMarker(ctx, x, y, color, 4.5, 2);
        }
    }
}

function drawCursorOnChart(chart, overlayId, pointA, colorA, valA, pointB, colorB, valB, isSwimlane = false, nameA = '', nameB = '') {
    if (!chart || !chart.chartArea || !chart.scales.x || !chart.scales.y) return;

    const ctx = prepareOverlayCanvas(overlayId);
    if (!ctx) return;

    renderDriverCursor(ctx, chart.chartArea, chart.scales, pointA, colorA, valA, isSwimlane, nameA);
    renderDriverCursor(ctx, chart.chartArea, chart.scales, pointB, colorB, valB, isSwimlane, nameB);

    ctx.restore();
}

// ============================================================
// 5. PUBLIC LIFECYCLE & API
// ============================================================

export function clearChartOverlays() {
    ['speedOverlay', 'throttleOverlay', 'brakeOverlay'].forEach(id => {
        const canvas = document.getElementById(id);
        if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    });
}

export function destroyCharts() {
    if (state.speedChart) {
        state.speedChart.destroy();
        state.speedChart = null;
    }
    if (state.throttleChart) {
        state.throttleChart.destroy();
        state.throttleChart = null;
    }
    if (state.brakeChart) {
        state.brakeChart.destroy();
        state.brakeChart = null;
    }
    clearChartOverlays();
}

export const destroyChart = destroyCharts;

export function renderCharts(lapIndex) {
    if (!state.carState) return;
    const { a, b } = state.carState;
    destroyCharts();

    const aData = a.carData[lapIndex] || [];
    const bData = b.carData[lapIndex] || [];

    state.speedChart = createSpeedChart(document.getElementById('speedChart'), a, aData, b, bData);
    state.throttleChart = createThrottleChart(document.getElementById('throttleChart'), a, aData, b, bData);
    state.brakeChart = createBrakeChart(document.getElementById('brakeChart'), a, aData, b, bData);
}

export const renderChart = renderCharts;

export function updateChartCursors(pointA, pointB) {
    if (!state.carState) return;
    const { a, b } = state.carState;

    drawCursorOnChart(state.speedChart, 'speedOverlay', pointA, a.color, pointA?.speed, pointB, b.color, pointB?.speed, false);
    drawCursorOnChart(state.throttleChart, 'throttleOverlay', pointA, a.color, pointA?.throttle, pointB, b.color, pointB?.throttle, false);
    drawCursorOnChart(
        state.brakeChart,
        'brakeOverlay',
        pointA,
        a.color,
        pointA ? normalizeBrake(pointA.brake) : 0,
        pointB,
        b.color,
        pointB ? normalizeBrake(pointB.brake) : 0,
        true,
        a.info.full_name,
        b.info.full_name
    );
}
