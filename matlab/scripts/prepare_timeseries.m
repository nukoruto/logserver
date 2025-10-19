%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

function tsStruct = prepare_timeseries(dataPath, configPath)
%PREPARE_TIMESERIES Load simulation data and convert to timeseries structs.
%   TSSTRUCT = PREPARE_TIMESERIES(DATAPATH, CONFIGPATH) reads CSV data with
%   timestamps and control responses, aligns them to the sampling period Ts,
%   and returns a struct with Simulink-compatible timeseries objects.

arguments
    dataPath (1, 1) string
    configPath (1, 1) string = fullfile(fileparts(mfilename('fullpath')), '..', 'config', 'sim_config.json');
end

config = jsondecode(fileread(configPath));
opts = detectImportOptions(dataPath, "Delimiter", ",");
tableData = readtable(dataPath, opts);

if ~ismember('time', tableData.Properties.VariableNames)
    error('prepare_timeseries:MissingColumn', 'Input table must contain a ''time'' column in seconds.');
end

timeVec = tableData.time;
if config.simulation.forceUniformGrid
    Ts = config.simulation.Ts;
    tMin = timeVec(1);
    tMax = timeVec(end);
    timeVec = (tMin:Ts:tMax)';
end

signalVars = setdiff(tableData.Properties.VariableNames, {'time'});

tsStruct = struct();
tsStruct.Time = double(timeVec);
for idx = 1:numel(signalVars)
    fieldName = signalVars{idx};
    values = double(tableData.(fieldName));
    tsStruct.(fieldName) = timeseries(values, tsStruct.Time, 'Name', fieldName);
end
end
