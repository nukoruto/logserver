function artifactsDir = run_all(config_path)
%RUN_ALL Execute the full Simulink comparison pipeline headlessly.
%   ARTIFACTSDIR = RUN_ALL(CONFIG_PATH) regenerates the Simulink model,
%   prepares Structure-with-Time inputs, runs the simulation, recomputes
%   response metrics, and exports comparison reports. CONFIG_PATH defaults
%   to config/sim_config.json when omitted. The function returns the fully
%   qualified artifacts directory created for this run.
arguments
    config_path (1, :) char = ''
end

scriptDir = fileparts(mfilename('fullpath'));
repoRoot = fileparts(scriptDir);

if config_path == ""
    config_path = fullfile(repoRoot, 'config', 'sim_config.json');
elseif ~is_absolute_path(config_path)
    config_path = fullfile(repoRoot, config_path);
end

if exist(config_path, 'file') ~= 2
    error('run_all:MissingConfig', 'Configuration file %s not found.', config_path);
end

cfg = jsondecode(fileread(config_path));
utilDir = fullfile(repoRoot, 'matlab', 'util');
addpath(utilDir);

artifactRoot = resolve_path(cfg.simulation.artifact_root, repoRoot);
artifactsDir = make_artifacts(artifactRoot);
cfg.simulation.artifact_root = artifactRoot;
cfg.simulation.run_id = char(fileparts_relative(artifactsDir));

preparedDir = fullfile(artifactsDir, 'prepared');
if exist(preparedDir, 'dir') ~= 7 %#ok<EXIST>
    mkdir(preparedDir);
end
cfg.data.output_dir = preparedDir;

cfg.model_path = resolve_path(cfg.model_path, repoRoot);
cfg.data.ref_csv = resolve_path(cfg.data.ref_csv, repoRoot);
cfg.data.lstm_csv = resolve_path(cfg.data.lstm_csv, repoRoot);
cfg.data.vocab_json = resolve_path(cfg.data.vocab_json, repoRoot);

runConfigPath = fullfile(artifactsDir, 'run_config.json');
write_config(runConfigPath, cfg);

build_pid_vs_lstm_model(runConfigPath);
prepare_timeseries(runConfigPath);
run_simulation(runConfigPath);
analyze_time_domain(runConfigPath);
export_report(runConfigPath);

end

function absPath = resolve_path(pathStr, baseDir)
if strlength(pathStr) == 0
    absPath = char(pathStr);
    return;
end
if is_absolute_path(pathStr)
    absPath = char(pathStr);
else
    absPath = fullfile(baseDir, pathStr);
end
end

function tf = is_absolute_path(pathStr)
pathStr = char(pathStr);
if ispc
    tf = ~isempty(regexp(pathStr, '^[A-Za-z]:[\\/]', 'once')) || startsWith(pathStr, '\\');
else
    tf = startsWith(pathStr, filesep);
end
end

function name = fileparts_relative(pathStr)
[~, name] = fileparts(pathStr);
end

function write_config(pathStr, cfg)
jsonText = jsonencode(cfg, PrettyPrint=true);
fid = fopen(pathStr, 'w');
if fid == -1
    error('run_all:CannotWriteConfig', 'Unable to open %s for writing.', pathStr);
end
cleaner = onCleanup(@() fclose(fid));
fprintf(fid, '%s\n', jsonText);
clear cleaner;
end
