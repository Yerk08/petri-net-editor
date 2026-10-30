global.structuredClone = (val) => JSON.parse(JSON.stringify(val));

jest.mock('../modules/render.js', () => ({
    render: jest.fn(),
    updatePropertyWhileSimulation: jest.fn(),
    renderAnalysisTaskControl: jest.fn(),
    renderDynamicFields: jest.fn()
}));

jest.mock('../editor.js', () => ({
    selectObject: jest.fn()
}));

global.confirm = jest.fn(() => true);
global.alert = jest.fn();

beforeEach(() => {
    document.body.innerHTML = `
        <div id="petri-svg"></div>
        <div id="canvas-container"></div>
        <div id="left-menu"><button id="btn-select"></button><button id="btn-simulation"></button></div>
        <input id="analysis-server-input" />
        <select id="analysis-type-select"></select>
    `;
    jest.clearAllMocks();
});
