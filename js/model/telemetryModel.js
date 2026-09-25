//------------------------------------------------------------
// TELEMETRY MODEL — laps, car data, location data (fetch + organize per lap)
//------------------------------------------------------------

import { fetchWithRetry } from './api.js';
import { state } from './state.js';

export const LAP_COLUMN_NAMES = [
    'lap_number', 'date_start', 'lap_duration', 'duration_sector_1',
    'duration_sector_2', 'duration_sector_3', 'i1_speed', 'i2_speed',
    'is_pit_out_lap', 'st_speed'
];

function getLapsUrl(driverNum) {
    return `https://api.openf1.org/v1/laps?session_key=${state.sessionKey}&driver_number=${driverNum}`;
}

function getSessionCarDataUrl(driverNum) {
    return `https://api.openf1.org/v1/car_data?driver_number=${driverNum}&session_key=${state.sessionKey}`;
}

function getLocationDataUrl(driverNum) {
    return `https://api.openf1.org/v1/location?driver_number=${driverNum}&session_key=${state.sessionKey}`;
}

export function addSecondsToDate(dateString, seconds) {
    const date = new Date(dateString);
    const newDate = new Date(date.getTime() + seconds * 1000);
    return newDate.toISOString();
}

export function addElapsedSeconds(currDate, lapStartTime) {
    return (new Date(currDate).getTime() - new Date(lapStartTime).getTime()) / 1000;
}

export async function getLaps(driverNum) {
    return await fetchWithRetry(getLapsUrl(driverNum), `laps for ${driverNum}`) ?? [];
}

async function getAllCarData(driverNum) {
    return await fetchWithRetry(getSessionCarDataUrl(driverNum), `car data for ${driverNum}`) ?? [];
}

async function getAllLocationData(driverNum) {
    return await fetchWithRetry(getLocationDataUrl(driverNum), `location for ${driverNum}`) ?? [];
}

async function organizeAllCarData(driverNum, driverLaps) {
    let data = await getAllCarData(driverNum);
    data = data.filter(x => x.date > driverLaps[0].date_start);
    data = data.reverse();
    const carLapsData = [];
    for (const lap of driverLaps) {
        const lapData = [];
        const lapEndTime = new Date(addSecondsToDate(lap.date_start, lap.lap_duration));
        while (data.length > 0 && new Date(data.at(-1).date) < lapEndTime) {
            lapData.push(data.pop());
        }
        carLapsData.push(lapData);
    }
    return carLapsData;
}

async function organizeAllLocationData(driverNum, driverLaps) {
    let data = await getAllLocationData(driverNum);
    data = data.filter(x => x.date > driverLaps[0].date_start);
    data = data.reverse();
    const carLapsData = [];
    for (const lap of driverLaps) {
        const lapData = [];
        const lapEndTime = new Date(addSecondsToDate(lap.date_start, lap.lap_duration));
        while (data.length > 0 && new Date(data.at(-1).date) < lapEndTime) {
            lapData.push(data.pop());
        }
        carLapsData.push(lapData);
    }
    return carLapsData;
}

export async function carDataReadyForChart(driverNum, driverLaps) {
    let carData = await organizeAllCarData(driverNum, driverLaps);
    for (let i = 0; i < driverLaps.length; i++) {
        const lapStartTime = driverLaps[i].date_start;
        carData[i] = carData[i].map(x => ({
            ...x,
            elapsedSeconds: addElapsedSeconds(x.date, lapStartTime)
        }));
    }
    return carData;
}

export async function carLocationDataReadyForChart(driverNum, driverLaps) {
    let carData = await organizeAllLocationData(driverNum, driverLaps);
    for (let i = 0; i < driverLaps.length; i++) {
        const lapStartTime = driverLaps[i].date_start;
        carData[i] = carData[i].map(x => ({
            ...x,
            elapsedSeconds: addElapsedSeconds(x.date, lapStartTime)
        }));
    }
    return carData;
}
