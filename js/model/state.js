//------------------------------------------------------------
// SHARED STATE — values the model updates and views/controllers read
//------------------------------------------------------------

export const state = {
    sessionKey: 0,
    currentSession: null,
    speedChart: null,
    throttleChart: null,
    brakeChart: null,
    carState: null,
    uniqueDrivers: [],
    years: [],
    circuitsByYear: {}
};
