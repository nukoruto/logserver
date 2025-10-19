function analyze_time_domain(config_path)
%ANALYZE_TIME_DOMAIN Recompute time-domain metrics from simulation outputs.
%   ANALYZE_TIME_DOMAIN(CONFIG_PATH) loads the raw SimulationOutput MAT
%   files recorded under artifacts/sim/<run_id>/raw, recomputes IAE/ISE/ITAE
%   for both PID and LSTM branches, validates the results against the
%   Simulink integrator outputs, evaluates transient metrics using
%   stepinfo/lsiminfo depending on the reference signal, and stores the
%   consolidated metrics as metrics.json.
arguments
    config_path (1, :) char = 'config/sim_config.json'
end

cfg = jsondecode(fileread(config_path));
run_root = fullfile(cfg.simulation.artifact_root, cfg.simulation.run_id);
raw_dir = fullfile(run_root, 'raw');
if ~isfolder(raw_dir)
    error('analyze_time_domain:MissingRawDirectory', ...
        'Raw directory %s does not exist. Run run_simulation first.', raw_dir);
end

settling_threshold = cfg.check.settling_percentage / 100.0;
Ts = cfg.Ts;

ref_sig = load_structure_with_time(fullfile(raw_dir, 'ref_sig.mat'));
y_lstm_sig = load_structure_with_time(fullfile(raw_dir, 'y_lstm_sig.mat'));
y_pid_sig = load_structure_with_time(fullfile(raw_dir, 'y_pid_sig.mat'));
e_pid_sig = load_structure_with_time(fullfile(raw_dir, 'e_pid.mat'));
e_lstm_sig = load_structure_with_time(fullfile(raw_dir, 'e_lstm.mat'));

pid_integrals = struct();
pid_integrals.iae = recompute_integral(e_pid_sig, Ts, 'iae');
pid_integrals.ise = recompute_integral(e_pid_sig, Ts, 'ise');
pid_integrals.itae = recompute_integral(e_pid_sig, Ts, 'itae');

lstm_integrals = struct();
lstm_integrals.iae = recompute_integral(e_lstm_sig, Ts, 'iae');
lstm_integrals.ise = recompute_integral(e_lstm_sig, Ts, 'ise');
lstm_integrals.itae = recompute_integral(e_lstm_sig, Ts, 'itae');

verify_against_simulink(pid_integrals.iae, fullfile(raw_dir, 'iae_pid.mat'), 'iae_pid');
verify_against_simulink(pid_integrals.ise, fullfile(raw_dir, 'ise_pid.mat'), 'ise_pid');
verify_against_simulink(pid_integrals.itae, fullfile(raw_dir, 'itae_pid.mat'), 'itae_pid');

verify_against_simulink(lstm_integrals.iae, fullfile(raw_dir, 'iae_lstm.mat'), 'iae_lstm');
verify_against_simulink(lstm_integrals.ise, fullfile(raw_dir, 'ise_lstm.mat'), 'ise_lstm');
verify_against_simulink(lstm_integrals.itae, fullfile(raw_dir, 'itae_lstm.mat'), 'itae_lstm');

ref_time = ref_sig.time(:);
ref_primary = select_primary_channel(ref_sig.signals.values);

[info_fn, info_method] = choose_info_fn(ref_time, ref_primary, settling_threshold);

pid_primary = select_primary_channel(y_pid_sig.signals.values);
lstm_primary = select_primary_channel(y_lstm_sig.signals.values);

pid_info = info_fn(pid_primary);
lstm_info = info_fn(lstm_primary);

response_metrics_pid = extract_response_metrics(pid_info);
response_metrics_lstm = extract_response_metrics(lstm_info);

lstm_timing = compute_timing_error_sum(ref_sig, y_lstm_sig);
pid_timing = compute_timing_error_sum(ref_sig, y_pid_sig);
timing_error_sum = lstm_timing + pid_timing;

metrics = struct();
metrics.config_path = string(config_path);
metrics.git_hash = string(get_git_revision());
metrics.method = string(info_method);
metrics.settling_threshold = settling_threshold;
metrics.ts = Ts;
metrics.timing_error_sum = timing_error_sum;

metrics.pid = struct();
metrics.pid.iae = pid_integrals.iae;
metrics.pid.ise = pid_integrals.ise;
metrics.pid.itae = pid_integrals.itae;
metrics.pid.rise_time = response_metrics_pid.RiseTime;
metrics.pid.settling_time = response_metrics_pid.SettlingTime;
metrics.pid.overshoot = response_metrics_pid.Overshoot;
metrics.pid.peak_value = response_metrics_pid.Peak;
metrics.pid.peak_time = response_metrics_pid.PeakTime;

metrics.lstm = struct();
metrics.lstm.iae = lstm_integrals.iae;
metrics.lstm.ise = lstm_integrals.ise;
metrics.lstm.itae = lstm_integrals.itae;
metrics.lstm.rise_time = response_metrics_lstm.RiseTime;
metrics.lstm.settling_time = response_metrics_lstm.SettlingTime;
metrics.lstm.overshoot = response_metrics_lstm.Overshoot;
metrics.lstm.peak_value = response_metrics_lstm.Peak;
metrics.lstm.peak_time = response_metrics_lstm.PeakTime;

metrics_path = fullfile(run_root, 'metrics.json');
json_text = jsonencode(metrics, PrettyPrint=true);
fid = fopen(metrics_path, 'w');
if fid == -1
    error('analyze_time_domain:CannotOpenFile', 'Unable to open %s for writing.', metrics_path);
end
cleaner = onCleanup(@() fclose(fid));
fprintf(fid, '%s\n', json_text);
clear cleaner;

end

function data = load_structure_with_time(path)
if ~exist(path, 'file')
    error('analyze_time_domain:MissingFile', 'Expected MAT file %s not found.', path);
end
payload = load(path);
if ~isfield(payload, 'time') || ~isfield(payload, 'signals')
    error('analyze_time_domain:InvalidStructure', ...
        'MAT file %s must contain time and signals fields.', path);
end
payload.time = double(payload.time(:));
payload.signals.values = double(payload.signals.values);
data = payload;
end

function value = recompute_integral(signal_struct, Ts, mode)
values = double(signal_struct.signals.values);
time = double(signal_struct.time(:));
dt = compute_sample_intervals(time, Ts);
switch mode
    case 'iae'
        aggregate = sum(abs(values), 2);
        value = sum(aggregate .* dt);
    case 'ise'
        aggregate = sum(values.^2, 2);
        value = sum(aggregate .* dt);
    case 'itae'
        aggregate = sum(abs(values), 2);
        value = sum(aggregate .* time .* dt);
    otherwise
        error('analyze_time_domain:UnsupportedMode', 'Unsupported integral mode: %s', mode);
end
end

function dt = compute_sample_intervals(time, Ts)
if numel(time) < 2
    dt = Ts;
    return;
end
raw = diff(time);
if all(raw > 0)
    dt = [raw; raw(end)];
else
    dt = [repmat(Ts, numel(time)-1, 1); Ts];
end
end

function verify_against_simulink(value, path, field_name)
if ~exist(path, 'file')
    error('analyze_time_domain:MissingIntegrator', ...
        'Simulink integral MAT file %s is missing.', path);
end
payload = load(path);
if ~isfield(payload, 'signals') || ~isfield(payload.signals, 'values')
    error('analyze_time_domain:InvalidIntegrator', ...
        'Integrator MAT file %s is malformed.', path);
end
sim_values = double(payload.signals.values);
if isvector(sim_values)
    sim_value = sim_values(end);
else
    sim_value = sim_values(end, 1);
end
if abs(sim_value - value) > 1e-9
    error('analyze_time_domain:IntegralMismatch', ...
        'Computed %s (%.12g) does not match Simulink output (%.12g).', ...
        field_name, value, sim_value);
end
end

function channel = select_primary_channel(values)
if isvector(values)
    channel = values(:);
else
    channel = values(:, 1);
end
end

function metrics = extract_response_metrics(info_struct)
metrics = struct();
metrics.RiseTime = extract_field(info_struct, 'RiseTime');
metrics.SettlingTime = extract_field(info_struct, 'SettlingTime');
metrics.Overshoot = extract_field(info_struct, 'Overshoot');
metrics.Peak = extract_field(info_struct, 'Peak');
metrics.PeakTime = extract_field(info_struct, 'PeakTime');
end

function value = extract_field(structure, field)
if isstruct(structure) && isfield(structure, field)
    value = double(structure.(field));
else
    value = NaN;
end
end

function total = compute_timing_error_sum(ref_sig, resp_sig)
ref_times = collect_rising_edges(ref_sig);
resp_times = collect_rising_edges(resp_sig);
len = min(numel(ref_times), numel(resp_times));
if len == 0
    total = 0.0;
    return;
end
if numel(ref_times) ~= numel(resp_times)
    warning('analyze_time_domain:EventCountMismatch', ...
        'Mismatch between reference (%d) and response (%d) rising edges.', ...
        numel(ref_times), numel(resp_times));
end
aligned = sum(abs(resp_times(1:len) - ref_times(1:len)));
total = aligned;
end

function times = collect_rising_edges(signal_struct)
values = double(signal_struct.signals.values);
time = double(signal_struct.time(:));
threshold = 0.5;
if isempty(values)
    times = zeros(0, 1);
    return;
end
if isvector(values)
    mask = values(:) >= threshold;
    edges = find(diff([false; mask]) == 1);
    times = time(edges);
else
    times = zeros(0, 1);
    for col = 1:size(values, 2)
        mask = values(:, col) >= threshold;
        edges = find(diff([false; mask]) == 1);
        times = [times; time(edges)]; %#ok<AGROW>
    end
    times = sort(times, 'ascend');
end
end

function hash = get_git_revision()
[status, output] = system('git rev-parse HEAD');
if status ~= 0
    hash = "unknown";
else
    hash = string(strtrim(output));
end
end
