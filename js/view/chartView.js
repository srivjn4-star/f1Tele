//------------------------------------------------------------
// CHART VIEW — corner-by-corner speed line chart
//------------------------------------------------------------

import { state } from '../model/state.js';

export function destroyChart() {
    if (state.speedChart) {
        state.speedChart.destroy();
        state.speedChart = null;
    }
}

export function renderChart(lapIndex) {
    const a = state.carState.a;
    const b = state.carState.b;
    destroyChart();

    state.speedChart = new Chart(document.getElementById('speedChart'), {
        type: 'line',
        data: {
            datasets: [
                {
                    label: a.info.full_name,
                    data: a.carData[lapIndex].map(point => ({ x: point.elapsedSeconds, y: point.speed })),
                    borderColor: a.color,
                    fill: true,
                    pointRadius: 0
                },
                {
                    label: b.info.full_name,
                    data: b.carData[lapIndex].map(point => ({ x: point.elapsedSeconds, y: point.speed })),
                    borderColor: b.color,
                    fill: true,
                    pointRadius: 0
                }
            ]
        },
        options: {
            scales: {
                x: { type: 'linear', title: { display: true, text: 'Elapsed time (s)' } },
                y: { title: { display: true, text: 'Speed (km/h)' } }
            }
        }
    });
}
