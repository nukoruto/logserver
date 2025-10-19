function export_report(config_path)
%EXPORT_REPORT Generate PNG/CSV/Markdown artifacts from simulation results.
%   EXPORT_REPORT(CONFIG_PATH) consolidates the simulation outputs and
%   analytics (metrics.json) into publication-ready artifacts located under
%   artifacts/sim/<run_id>/report.
arguments
    config_path (1, :) char = 'config/sim_config.json'
end

cfg = jsondecode(fileread(config_path));
run_root = fullfile(cfg.simulation.artifact_root, cfg.simulation.run_id);
raw_dir = fullfile(run_root, 'raw');
report_dir = fullfile(run_root, 'report');
if ~isfolder(raw_dir)
    error('export_report:MissingRawDirectory', ...
        'Raw directory %s not found. Run run_simulation first.', raw_dir);
end
if ~exist(report_dir, 'dir') %#ok<EXIST>
    mkdir(report_dir);
end

ref_sig = load_structure_with_time(fullfile(raw_dir, 'ref_sig.mat'));
y_lstm_sig = load_structure_with_time(fullfile(raw_dir, 'y_lstm_sig.mat'));
y_pid_sig = load_structure_with_time(fullfile(raw_dir, 'y_pid_sig.mat'));
e_lstm_sig = load_structure_with_time(fullfile(raw_dir, 'e_lstm.mat'));
e_pid_sig = load_structure_with_time(fullfile(raw_dir, 'e_pid.mat'));
check_sig = load_structure_with_time(fullfile(raw_dir, 'check_flags.mat'));
count_sig = optional_structure_with_time(fullfile(raw_dir, 'k_of_n_count.mat'));

export_waveform_overlay(ref_sig, y_lstm_sig, y_pid_sig, report_dir);
export_error_overlay(e_lstm_sig, e_pid_sig, report_dir);
export_violation_log(check_sig, count_sig, report_dir);

metrics_path = fullfile(run_root, 'metrics.json');
if ~exist(metrics_path, 'file')
    error('export_report:MissingMetrics', ...
        'metrics.json not found. Run analyze_time_domain first.');
end
metrics = jsondecode(fileread(metrics_path));
model_hash = compute_file_sha256(cfg.model_path);
write_results_markdown(metrics, cfg, model_hash, report_dir, config_path);

end

function export_waveform_overlay(ref_sig, lstm_sig, pid_sig, out_dir)
ref_time = ref_sig.time(:);
ref_primary = select_primary_channel(ref_sig.signals.values);
lstm_primary = select_primary_channel(lstm_sig.signals.values);
pid_primary = select_primary_channel(pid_sig.signals.values);

fig = figure('Visible', 'off', 'Color', 'white');
plot(ref_time, ref_primary, 'k-', 'LineWidth', 1.5); hold on;
plot(lstm_sig.time, lstm_primary, 'LineWidth', 1.2);
plot(pid_sig.time, pid_primary, 'LineWidth', 1.2);
legend({'ref', 'y\_lstm', 'y\_pid'}, 'Location', 'best');
xlabel('Time [s]');
ylabel('Signal');
title('Reference and Response Signals');
grid on;
exportgraphics(fig, fullfile(out_dir, 'waveform_overlay.png'), 'Resolution', 300);
close(fig);
end

function export_error_overlay(e_lstm_sig, e_pid_sig, out_dir)
time = e_lstm_sig.time(:);
lstm_error = compute_error_norm(e_lstm_sig.signals.values);
pid_error = compute_error_norm(e_pid_sig.signals.values);
fig = figure('Visible', 'off', 'Color', 'white');
plot(time, lstm_error, 'LineWidth', 1.2); hold on;
plot(e_pid_sig.time, pid_error, 'LineWidth', 1.2);
legend({'|e\_lstm|', '|e\_pid|'}, 'Location', 'best');
xlabel('Time [s]');
ylabel('Error Norm');
title('Error Waveforms');
grid on;
exportgraphics(fig, fullfile(out_dir, 'error_overlay.png'), 'Resolution', 300);
close(fig);
end

function export_violation_log(check_sig, count_sig, out_dir)
time = check_sig.time(:);
alarm = select_primary_channel(check_sig.signals.values);
alarm = double(alarm >= 0.5);
if isempty(count_sig)
    count = nan(numel(time), 1);
else
    count = select_primary_channel(count_sig.signals.values);
    count = double(count(:));
    len = min(numel(count), numel(time));
    if len < numel(time)
        count = [count(1:len); nan(numel(time) - len, 1)]; %#ok<AGROW>
    end
end

csv_path = fullfile(out_dir, 'violation_log.csv');
fid = fopen(csv_path, 'w');
if fid == -1
    error('export_report:CannotOpenCSV', 'Unable to open %s for writing.', csv_path);
end
cleaner = onCleanup(@() fclose(fid));
fprintf(fid, 'time,alarm,countK\n');
for idx = 1:numel(time)
    if isnan(count(idx))
        fprintf(fid, '%.12g,%d,\n', time(idx), alarm(idx));
    else
        fprintf(fid, '%.12g,%d,%.12g\n', time(idx), alarm(idx), count(idx));
    end
end
clear cleaner;
end

function data = load_structure_with_time(path)
if ~exist(path, 'file')
    error('export_report:MissingFile', 'Expected MAT file %s not found.', path);
end
payload = load(path);
if ~isfield(payload, 'time') || ~isfield(payload, 'signals')
    error('export_report:InvalidStructure', ...
        'MAT file %s must contain time and signals fields.', path);
end
payload.time = double(payload.time(:));
payload.signals.values = double(payload.signals.values);
data = payload;
end

function data = optional_structure_with_time(path)
if exist(path, 'file')
    data = load_structure_with_time(path);
else
    data = [];
end
end

function channel = select_primary_channel(values)
if isvector(values)
    channel = values(:);
else
    channel = values(:, 1);
end
end

function norms = compute_error_norm(values)
if isvector(values)
    norms = abs(values(:));
else
    norms = vecnorm(values, 2, 2);
end
end

function write_results_markdown(metrics, cfg, model_hash, out_dir, config_path)
lines = {};
lines{end+1} = '# Simulation Results'; %#ok<AGROW>
lines{end+1} = ''; %#ok<AGROW>
lines{end+1} = '## Metadata'; %#ok<AGROW>
lines{end+1} = sprintf('- Config: %s', config_path); %#ok<AGROW>
lines{end+1} = sprintf('- Model: %s', cfg.model_path); %#ok<AGROW>
lines{end+1} = sprintf('- Model SHA256: %s', model_hash); %#ok<AGROW>
lines{end+1} = sprintf('- Git commit: %s', metrics.git_hash); %#ok<AGROW>
lines{end+1} = sprintf('- Metrics method: %s', metrics.method); %#ok<AGROW>
lines{end+1} = ''; %#ok<AGROW>
lines{end+1} = '## Metrics'; %#ok<AGROW>
lines{end+1} = '### PID'; %#ok<AGROW>
lines = append_metric_block(lines, metrics.pid);
lines{end+1} = ''; %#ok<AGROW>
lines{end+1} = '### LSTM'; %#ok<AGROW>
lines = append_metric_block(lines, metrics.lstm);
lines{end+1} = ''; %#ok<AGROW>
lines{end+1} = '### Timing'; %#ok<AGROW>
lines{end+1} = sprintf('- timing\_error\_sum: %.12g', metrics.timing_error_sum); %#ok<AGROW>
lines{end+1} = ''; %#ok<AGROW>
lines{end+1} = '## Generated Artifacts'; %#ok<AGROW>
lines{end+1} = '- waveform\_overlay.png'; %#ok<AGROW>
lines{end+1} = '- error\_overlay.png'; %#ok<AGROW>
lines{end+1} = '- violation\_log.csv'; %#ok<AGROW>
lines{end+1} = '- metrics.json'; %#ok<AGROW>

md_path = fullfile(out_dir, 'results.md');
fid = fopen(md_path, 'w');
if fid == -1
    error('export_report:CannotOpenMarkdown', 'Unable to open %s for writing.', md_path);
end
cleaner = onCleanup(@() fclose(fid));
for i = 1:numel(lines)
    fprintf(fid, '%s\n', lines{i});
end
clear cleaner;
end

function lines = append_metric_block(lines, metrics)
lines{end+1} = sprintf('- iae: %.12g', metrics.iae); %#ok<AGROW>
lines{end+1} = sprintf('- ise: %.12g', metrics.ise); %#ok<AGROW>
lines{end+1} = sprintf('- itae: %.12g', metrics.itae); %#ok<AGROW>
lines{end+1} = sprintf('- rise\_time: %.12g', metrics.rise_time); %#ok<AGROW>
lines{end+1} = sprintf('- settling\_time: %.12g', metrics.settling_time); %#ok<AGROW>
lines{end+1} = sprintf('- overshoot: %.12g', metrics.overshoot); %#ok<AGROW>
lines{end+1} = sprintf('- peak\_value: %.12g', metrics.peak_value); %#ok<AGROW>
lines{end+1} = sprintf('- peak\_time: %.12g', metrics.peak_time); %#ok<AGROW>
end

function hash = compute_file_sha256(path)
if ~exist(path, 'file')
    hash = 'missing';
    return;
end
file = java.io.File(path);
stream = java.io.FileInputStream(file);
cleaner = onCleanup(@() stream.close());
digest = java.security.MessageDigest.getInstance('SHA-256');
buffer = zeros(4096, 1, 'uint8');
while true
    read_len = stream.read(buffer);
    if read_len == -1
        break;
    end
    digest.update(buffer(1:read_len));
end
hash_bytes = typecast(digest.digest(), 'uint8');
hash = lower(join(string(dec2hex(hash_bytes, 2)), ''));
hash = hash{1};
end

