function run_simulink(config_path)
%RUN_SIMULINK Execute the Simulink comparison between LSTM and PID controllers.
%   RUN_SIMULINK(CONFIG_PATH) expects a JSON file containing simulation
%   parameters such as the MAT file exported from Python, sampling time,
%   plant coefficients, PID gains, and output directory settings. When
%   CONFIG_PATH is omitted the script looks for `Simulink.env.json` in the
%   same directory as this file.
%
%   The script programmatically generates (or loads) the `compare_lstm_pid`
%   model, configures solver/sample time, executes a deterministic
%   fixed-step simulation, and stores metrics (IAE/ISE/ITAE, stepinfo),
%   waveform samples, and bound violations in CSV form under
%   `artifacts/simulink/<run_id>/`.
%
%   The JSON configuration must include at minimum:
%       signals_mat : path to MAT file with `r`, `yLSTM`, `meta`
%       Ts          : sampling period [s]
%       K           : plant gain
%       tau         : plant time constant
%       run_id      : identifier for the experiment (used in output path)
%       out_dir     : base directory for artifacts
%
%   Optional fields:
%       pid         : struct with fields Kp, Ki, Kd, N
%       settle_band : settling band (fraction, e.g., 0.02)
%       bounds      : struct with RiseTimeMax, SettlingTimeMax, OvershootMax
%       waveforms_decimation : integer step when exporting CSV
%
%   Example invocation (MATLAB batch mode):
%       matlab -batch "run('trainer/src/logserver/simulink/model/run_simulink.m')"
%
%   This script avoids randomness; all computations are deterministic when
%   given the same inputs.

arguments
    config_path (1, :) char = ""
end

this_dir = fileparts(mfilename('fullpath'));
if strlength(config_path) == 0
    config_path = fullfile(this_dir, 'Simulink.env.json');
end
if ~isfile(config_path)
    error('Simulink:ConfigNotFound', 'Config file not found: %s', config_path);
end

cfg = jsondecode(fileread(config_path));
required_fields = {"signals_mat", "Ts", "K", "tau", "run_id", "out_dir"};
for idx = 1:numel(required_fields)
    key = required_fields{idx};
    if ~isfield(cfg, key)
        error('Simulink:MissingField', 'Missing required config field: %s', key);
    end
end

signals_path = cfg.signals_mat;
if ~isfile(signals_path)
    error('Simulink:SignalsMissing', 'signals_mat not found: %s', signals_path);
end

loaded = load(signals_path, 'r', 'yLSTM', 'meta');
if ~isfield(loaded, 'r') || ~isfield(loaded, 'yLSTM')
    error('Simulink:SignalsInvalid', 'MAT file must contain variables r and yLSTM.');
end

Ts = cfg.Ts;
K = cfg.K;
tau = cfg.tau;
run_id = string(cfg.run_id);
out_root = string(cfg.out_dir);
if strlength(out_root) == 0
    error('Simulink:OutputDirEmpty', 'out_dir must not be empty');
end
out_dir = fullfile(out_root, run_id);
if exist(out_dir, 'dir') ~= 7 %#ok<REMFF1>
    mkdir(out_dir);
end

pid_cfg = struct('Kp', 1.0, 'Ki', 0.0, 'Kd', 0.0, 'N', 100.0);
if isfield(cfg, 'pid')
    pid_cfg = merge_struct(pid_cfg, cfg.pid);
end

settle_band = 0.02;
if isfield(cfg, 'settle_band')
    settle_band = cfg.settle_band;
end

bounds = struct('RiseTimeMax', [], 'SettlingTimeMax', [], 'OvershootMax', []);
if isfield(cfg, 'bounds')
    bounds = merge_struct(bounds, cfg.bounds);
end

decimation = 1;
if isfield(cfg, 'waveforms_decimation') && cfg.waveforms_decimation > 0
    decimation = max(1, floor(cfg.waveforms_decimation));
end

assignin('base', 'Ts', Ts);
assignin('base', 'r', loaded.r);
assignin('base', 'yLSTM', loaded.yLSTM);
assignin('base', 'meta', loaded.meta);

mdl = ensure_model(this_dir, Ts, pid_cfg, K, tau, settle_band, bounds);

start_time = min(loaded.r.time(1), loaded.yLSTM.time(1));
stop_time = max(loaded.r.time(end), loaded.yLSTM.time(end));
if stop_time <= start_time
    error('Simulink:InvalidTimeRange', '停止時刻が開始時刻以下です。');
end
stop_duration = stop_time - start_time;

simIn = Simulink.SimulationInput(mdl);
simIn = setModelParameter(simIn, 'StopTime', num2str(stop_duration));
simIn = setModelParameter(simIn, 'Solver', 'FixedStepDiscrete');
simIn = setModelParameter(simIn, 'FixedStep', num2str(Ts));
simIn = setModelParameter(simIn, 'ReturnWorkspaceOutputs', 'on');
simIn = setModelParameter(simIn, 'SignalLogging', 'on');
simIn = setModelParameter(simIn, 'SignalLoggingName', 'simlog');

simOut = sim(simIn);

[r_series, y_lstm_series, y_pid_series, e_pid_series, e_lstm_series] = ...
    extract_series(simOut);

metrics = compute_metrics(r_series, y_pid_series, y_lstm_series, e_pid_series, e_lstm_series, Ts);

model_checksum = get_model_checksum(mdl);
meta_hash = extract_meta_hash(loaded);

results_table = table();
results_table.run_id = run_id;
results_table.Ts = Ts;
results_table.K = K;
results_table.tau = tau;
results_table.settle_band = settle_band;
results_table.git_commit = string(extract_git_commit());
results_table.data_hash = meta_hash;
results_table.model_checksum = string(model_checksum);
results_table.iae_pid = metrics.pid.IAE;
results_table.ise_pid = metrics.pid.ISE;
results_table.itae_pid = metrics.pid.ITAE;
results_table.iae_lstm = metrics.lstm.IAE;
results_table.ise_lstm = metrics.lstm.ISE;
results_table.itae_lstm = metrics.lstm.ITAE;

writetable(results_table, fullfile(out_dir, 'results.csv'));

stepinfo_table = struct2table(metrics.stepinfo, 'AsArray', true);
writetable(stepinfo_table, fullfile(out_dir, 'stepinfo.csv'));

bounds_table = evaluate_bounds(bounds, metrics.stepinfo);
writetable(bounds_table, fullfile(out_dir, 'bounds_violations.csv'));

waveforms_table = export_waveforms(r_series, y_lstm_series, y_pid_series, decimation);
writetable(waveforms_table, fullfile(out_dir, 'waveforms.csv'));

simlog = simOut.simlog;
save(fullfile(out_dir, 'simlog.mat'), 'simlog');

stepinfo_summary = struct('settle_band', settle_band, 'bounds', bounds);
save(fullfile(out_dir, 'results_metadata.mat'), 'metrics', 'stepinfo_summary', 'pid_cfg', 'cfg', '-v7');

end

function merged = merge_struct(base_struct, override_struct)
merged = base_struct;
fields = fieldnames(override_struct);
for i = 1:numel(fields)
    key = fields{i};
    merged.(key) = override_struct.(key);
end
end

function mdl = ensure_model(base_dir, Ts, pid_cfg, K, tau, settle_band, bounds)
mdl_name = 'compare_lstm_pid';
mdl_path = fullfile(base_dir, 'templates', [mdl_name, '.slx']);
if isfile(mdl_path)
    load_system(mdl_path);
else
    new_system(mdl_name);
    open_system(mdl_name);
    build_model(mdl_name);
    save_system(mdl_name, mdl_path);
    close_system(mdl_name);
    load_system(mdl_path);
end

configure_model(mdl_name, Ts, pid_cfg, K, tau, settle_band, bounds);
mdl = mdl_name;
end

function configure_model(mdl_name, Ts, pid_cfg, K, tau, settle_band, bounds)
set_param(mdl_name, 'Solver', 'FixedStepDiscrete');
set_param(mdl_name, 'FixedStep', num2str(Ts));
set_param(mdl_name, 'StopTime', 'Ts');

set_param([mdl_name, '/r_from_ws'], 'VariableName', 'r');
set_param([mdl_name, '/y_from_ws'], 'VariableName', 'yLSTM');
set_param([mdl_name, '/r_zoh'], 'SampleTime', 'Ts');
set_param([mdl_name, '/y_zoh'], 'SampleTime', 'Ts');
set_param([mdl_name, '/PID'], 'P', num2str(pid_cfg.Kp));
set_param([mdl_name, '/PID'], 'I', num2str(pid_cfg.Ki));
set_param([mdl_name, '/PID'], 'D', num2str(pid_cfg.Kd));
set_param([mdl_name, '/PID'], 'N', num2str(pid_cfg.N));
set_param([mdl_name, '/PID'], 'TimeDomain', 'Continuous-time');
set_param([mdl_name, '/PID'], 'SampleTime', '0');
set_param([mdl_name, '/Plant'], 'Numerator', mat2str(K));
set_param([mdl_name, '/Plant'], 'Denominator', mat2str([tau, 1]));
set_param([mdl_name, '/Plant'], 'SampleTime', '0');
set_param([mdl_name, '/y_pid_zoh'], 'SampleTime', 'Ts');
set_param([mdl_name, '/CheckStep'], 'SettlingTimeThreshold', num2str(settle_band));

if ~isempty(bounds.RiseTimeMax)
    set_param([mdl_name, '/CheckStep'], 'RiseTimeCheck', 'on');
    set_param([mdl_name, '/CheckStep'], 'RiseTimeUpperBound', num2str(bounds.RiseTimeMax));
else
    set_param([mdl_name, '/CheckStep'], 'RiseTimeCheck', 'off');
end
if ~isempty(bounds.SettlingTimeMax)
    set_param([mdl_name, '/CheckStep'], 'SettlingTimeCheck', 'on');
    set_param([mdl_name, '/CheckStep'], 'SettlingTimeUpperBound', num2str(bounds.SettlingTimeMax));
else
    set_param([mdl_name, '/CheckStep'], 'SettlingTimeCheck', 'off');
end
if ~isempty(bounds.OvershootMax)
    set_param([mdl_name, '/CheckStep'], 'OvershootCheck', 'on');
    set_param([mdl_name, '/CheckStep'], 'OvershootUpperBound', num2str(bounds.OvershootMax));
else
    set_param([mdl_name, '/CheckStep'], 'OvershootCheck', 'off');
end
end

function build_model(mdl_name)
add_block('simulink/Sources/From Workspace', [mdl_name, '/r_from_ws'], 'Position', [30, 40, 200, 90]);
add_block('simulink/Discrete/Zero-Order Hold', [mdl_name, '/r_zoh'], 'Position', [250, 40, 300, 90]);
add_block('simulink/Sources/From Workspace', [mdl_name, '/y_from_ws'], 'Position', [30, 160, 200, 210]);
add_block('simulink/Discrete/Zero-Order Hold', [mdl_name, '/y_zoh'], 'Position', [250, 160, 300, 210]);
add_block('simulink/Math Operations/Sum', [mdl_name, '/SumPID'], 'Inputs', '+-', 'Position', [360, 40, 380, 90]);
add_block('simulink/Commonly Used Blocks/PID Controller', [mdl_name, '/PID'], 'Position', [430, 25, 510, 105]);
add_block('simulink/Continuous/Transfer Fcn', [mdl_name, '/Plant'], 'Position', [550, 25, 620, 105]);
add_block('simulink/Discrete/Zero-Order Hold', [mdl_name, '/y_pid_zoh'], 'Position', [650, 25, 700, 105]);
add_block('simulink/Math Operations/Sum', [mdl_name, '/SumLSTM'], 'Inputs', '+-', 'Position', [360, 160, 380, 210]);
add_block('simulink/Sinks/To Workspace', [mdl_name, '/to_r'], 'VariableName', 'r_series', 'SaveFormat', 'StructureWithTime', 'Position', [760, 20, 840, 60]);
add_block('simulink/Sinks/To Workspace', [mdl_name, '/to_y_pid'], 'VariableName', 'y_pid_series', 'SaveFormat', 'StructureWithTime', 'Position', [760, 80, 840, 120]);
add_block('simulink/Sinks/To Workspace', [mdl_name, '/to_y_lstm'], 'VariableName', 'y_lstm_series', 'SaveFormat', 'StructureWithTime', 'Position', [760, 140, 840, 180]);
add_block('simulink/Sinks/To Workspace', [mdl_name, '/to_e_pid'], 'VariableName', 'e_pid_series', 'SaveFormat', 'StructureWithTime', 'Position', [760, 200, 840, 240]);
add_block('simulink/Sinks/To Workspace', [mdl_name, '/to_e_lstm'], 'VariableName', 'e_lstm_series', 'SaveFormat', 'StructureWithTime', 'Position', [760, 260, 840, 300]);
add_block('simulink/Model-Wide Utilities/Check Step Response Characteristics', [mdl_name, '/CheckStep'], 'Position', [430, 140, 530, 220]);

add_line(mdl_name, 'r_from_ws/1', 'r_zoh/1', 'autorouting', 'on');
add_line(mdl_name, 'r_zoh/1', 'SumPID/1', 'autorouting', 'on');
add_line(mdl_name, 'SumPID/1', 'PID/1', 'autorouting', 'on');
add_line(mdl_name, 'PID/1', 'Plant/1', 'autorouting', 'on');
add_line(mdl_name, 'Plant/1', 'y_pid_zoh/1', 'autorouting', 'on');
add_line(mdl_name, 'y_pid_zoh/1', 'SumPID/2', 'autorouting', 'on');
add_line(mdl_name, 'r_zoh/1', 'SumLSTM/1', 'autorouting', 'on');
add_line(mdl_name, 'y_from_ws/1', 'y_zoh/1', 'autorouting', 'on');
add_line(mdl_name, 'y_zoh/1', 'SumLSTM/2', 'autorouting', 'on');
add_line(mdl_name, 'r_zoh/1', 'to_r/1', 'autorouting', 'on');
add_line(mdl_name, 'y_pid_zoh/1', 'to_y_pid/1', 'autorouting', 'on');
add_line(mdl_name, 'y_zoh/1', 'to_y_lstm/1', 'autorouting', 'on');
add_line(mdl_name, 'SumPID/1', 'to_e_pid/1', 'autorouting', 'on');
add_line(mdl_name, 'SumLSTM/1', 'to_e_lstm/1', 'autorouting', 'on');
add_line(mdl_name, 'r_zoh/1', 'CheckStep/1', 'autorouting', 'on');
add_line(mdl_name, 'y_pid_zoh/1', 'CheckStep/2', 'autorouting', 'on');
end

function [r_series, y_lstm_series, y_pid_series, e_pid_series, e_lstm_series] = extract_series(simOut)
r_series = simOut.r_series;
y_lstm_series = simOut.y_lstm_series;
y_pid_series = simOut.y_pid_series;
e_pid_series = simOut.e_pid_series;
e_lstm_series = simOut.e_lstm_series;
end

function metrics = compute_metrics(r_series, y_pid_series, y_lstm_series, e_pid_series, e_lstm_series, Ts)
metrics = struct();
metrics.pid = compute_error_metrics(e_pid_series, Ts);
metrics.lstm = compute_error_metrics(e_lstm_series, Ts);
metrics.stepinfo = compute_stepinfo(r_series, y_pid_series, y_lstm_series);
end

function err_metrics = compute_error_metrics(err_series, Ts)
time = err_series.time;
values = squeeze(err_series.signals.values);
elapsed = time - time(1);
abs_err = abs(values);
err_metrics = struct();
err_metrics.IAE = trapz(time, abs_err);
err_metrics.ISE = trapz(time, values.^2);
err_metrics.ITAE = trapz(time, elapsed .* abs_err);
end

function stepinfo_struct = compute_stepinfo(r_series, y_pid_series, y_lstm_series)
ref_values = squeeze(r_series.signals.values);
ref_time = r_series.time;
ref_final = ref_values(end);

pid_values = squeeze(y_pid_series.signals.values);
pid_time = y_pid_series.time;
lstm_values = squeeze(y_lstm_series.signals.values);
lstm_time = y_lstm_series.time;

pid_info = stepinfo(pid_values, pid_time, ref_final);
lstm_info = stepinfo(lstm_values, lstm_time, ref_final);

stepinfo_struct = struct();
stepinfo_struct.pid_RiseTime = pid_info.RiseTime;
stepinfo_struct.pid_SettlingTime = pid_info.SettlingTime;
stepinfo_struct.pid_Overshoot = pid_info.Overshoot;
stepinfo_struct.pid_PeakTime = pid_info.PeakTime;
stepinfo_struct.lstm_RiseTime = lstm_info.RiseTime;
stepinfo_struct.lstm_SettlingTime = lstm_info.SettlingTime;
stepinfo_struct.lstm_Overshoot = lstm_info.Overshoot;
stepinfo_struct.lstm_PeakTime = lstm_info.PeakTime;
end

function bounds_table = evaluate_bounds(bounds, stepinfo_struct)
violations = struct('metric', {}, 'value', {}, 'bound', {}, 'comparison', {});
if ~isempty(bounds.RiseTimeMax)
    value = stepinfo_struct.pid_RiseTime;
    if value > bounds.RiseTimeMax
        violations(end+1) = struct('metric', 'RiseTime', 'value', value, ...
            'bound', bounds.RiseTimeMax, 'comparison', '>'); %#ok<AGROW>
    end
end
if ~isempty(bounds.SettlingTimeMax)
    value = stepinfo_struct.pid_SettlingTime;
    if value > bounds.SettlingTimeMax
        violations(end+1) = struct('metric', 'SettlingTime', 'value', value, ...
            'bound', bounds.SettlingTimeMax, 'comparison', '>'); %#ok<AGROW>
    end
end
if ~isempty(bounds.OvershootMax)
    value = stepinfo_struct.pid_Overshoot;
    if value > bounds.OvershootMax
        violations(end+1) = struct('metric', 'Overshoot', 'value', value, ...
            'bound', bounds.OvershootMax, 'comparison', '>'); %#ok<AGROW>
    end
end

if isempty(violations)
    bounds_table = table(string.empty(0, 1), [], [], string.empty(0, 1), 'VariableNames', ...
        {'metric', 'value', 'bound', 'comparison'});
else
    bounds_table = struct2table(violations);
end
end

function waveforms_table = export_waveforms(r_series, y_lstm_series, y_pid_series, decimation)
ref_time = r_series.time;
ref_values = squeeze(r_series.signals.values);
pid_values = squeeze(y_pid_series.signals.values);
lstm_values = squeeze(y_lstm_series.signals.values);

N = numel(ref_time);
idx = 1:decimation:N;

waveforms_table = table();
waveforms_table.time = ref_time(idx);
waveforms_table.r = ref_values(idx);
waveforms_table.yLSTM = lstm_values(idx);
waveforms_table.yPID = pid_values(idx);
end

function checksum = get_model_checksum(mdl)
cs = Simulink.BlockDiagram.getChecksum(mdl);
checksum = compose('%08X%08X%08X%08X', cs.ModelChecksum);
end

function hash = extract_meta_hash(loaded)
if isfield(loaded, 'meta') && isfield(loaded.meta, 'data_hash')
    hash = string(loaded.meta.data_hash);
else
    hash = "UNKNOWN";
end
end

function commit = extract_git_commit()
try
    commit = string(getenv('GIT_COMMIT_HASH'));
    if strlength(commit) > 0
        return;
    end
catch
    % fall through
end

try
    [status, text] = system('git rev-parse HEAD');
    if status == 0
        commit = string(strtrim(text));
    else
        commit = "UNKNOWN";
    end
catch
    commit = "UNKNOWN";
end
end
