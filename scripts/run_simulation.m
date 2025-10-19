function run_simulation(config_path)
%RUN_SIMULATION Execute the pid_vs_lstm Simulink model with prepared data.
%   RUN_SIMULATION(CONFIG_PATH) loads the prepared Structure with Time MAT
%   files into the MATLAB base workspace and runs the generated Simulink
%   model using a fixed-step discrete solver. Simulation outputs emitted via
%   To Workspace blocks are saved under artifacts/sim/<run_id>/raw.
arguments
    config_path (1, :) char = 'config/sim_config.json'
end

cfg = jsondecode(fileread(config_path));
base_dir = fileparts(mfilename('fullpath'));
addpath(base_dir);
project_root = fileparts(base_dir);
addpath(fullfile(project_root, 'util'));

ref_payload = load(fullfile(cfg.data.output_dir, 'ref_sig.mat'));
y_payload = load(fullfile(cfg.data.output_dir, 'y_lstm_sig.mat'));
ref_sig = reconstruct_structure(ref_payload);
y_lstm_sig = reconstruct_structure(y_payload);
assignin('base', cfg.signals.ref_variable, ref_sig);
assignin('base', cfg.signals.lstm_variable, y_lstm_sig);

stop_time = compute_stop_time(ref_sig.time, y_lstm_sig.time, cfg.simulation.stop_time_offset);
model_path = cfg.model_path;
model_name = cfg.model_name;
if ~bdIsLoaded(model_name)
    load_system(model_path);
end

simOut = sim(model_name, ...
    'StopTime', num2str(stop_time, '%.12g'), ...
    'SrcWorkspace', 'base', ...
    'SaveOutput', 'on', ...
    'ReturnWorkspaceOutputs', 'on');

run_root = fullfile(cfg.simulation.artifact_root, cfg.simulation.run_id, 'raw');
if ~exist(run_root, 'dir') %#ok<EXIST>
    mkdir(run_root);
end

signals = string(cfg.simulation.to_workspace);
for idx = 1:numel(signals)
    name = char(signals(idx));
    if ~simOut.hasElement(name)
        warning('run_simulation:MissingSignal', ...
            'To Workspace signal %s not found in SimulationOutput.', name);
        continue;
    end
    data = simOut.get(name);
    output_file = fullfile(run_root, name + ".mat");
    if isstruct(data) && isfield(data, 'time') && isfield(data, 'signals')
        save_structure_with_time(data, output_file);
    else
        save(output_file, name, '-v7');
    end
end

metadata = struct();
metadata.config_path = config_path;
metadata.model = model_name;
metadata.stop_time = stop_time;
metadata.git_hash = get_git_revision();
metadata.generated_at = datetime('now', 'TimeZone', 'UTC');
metadata_path = fullfile(run_root, 'metadata.mat');
save(metadata_path, '-struct', 'metadata', '-v7');

end

function signal = reconstruct_structure(payload)
signal = payload;
if ~isfield(signal, 'time') || ~isfield(signal, 'signals')
    error('run_simulation:InvalidPayload', ...
        'MAT file must contain time and signals fields.');
end
signal.time = double(signal.time(:));
signal.signals.values = double(signal.signals.values);
end

function stop_time = compute_stop_time(ref_time, lstm_time, offset)
if nargin < 3
    offset = 0.0;
end
stop_time = max([ref_time(:); lstm_time(:)]);
stop_time = stop_time + double(offset);
end

function hash = get_git_revision()
[status, output] = system('git rev-parse HEAD');
if status ~= 0
    hash = 'unknown';
else
    hash = strtrim(output);
end
end
