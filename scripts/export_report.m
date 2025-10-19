function export_report(config_path)
%EXPORT_REPORT Generate figures and summary files from simulation outputs.
%   EXPORT_REPORT(CONFIG_PATH) reads the raw simulation results together
%   with metrics.json and produces overlay figures, CSV exports, and a
%   Markdown summary under artifacts/sim/<run_id>/report.
arguments
    config_path (1, :) char = 'config/sim_config.json'
end

script_dir = fileparts(mfilename('fullpath'));
project_root = fileparts(script_dir);
addpath(script_dir);

cfg = jsondecode(fileread(config_path));
run_root = fullfile(cfg.simulation.artifact_root, cfg.simulation.run_id);
raw_dir = fullfile(run_root, 'raw');
report_dir = fullfile(run_root, 'report');
if ~exist(raw_dir, 'dir') %#ok<EXIST>
    error('export_report:MissingRaw', ...
        'Raw directory %s does not exist. Run run_simulation first.', raw_dir);
end
if ~exist(report_dir, 'dir') %#ok<EXIST>
    mkdir(report_dir);
end

metrics_path = fullfile(run_root, 'metrics.json');
if ~exist(metrics_path, 'file') %#ok<EXIST>
    error('export_report:MissingMetrics', ...
        'metrics.json not found at %s. Run analyze_time_domain first.', metrics_path);
end
metrics = jsondecode(fileread(metrics_path));

ref_sig = load_structure(fullfile(raw_dir, 'ref_sig.mat'));
y_pid_sig = load_structure(fullfile(raw_dir, 'y_pid_sig.mat'));
y_lstm_sig = load_structure(fullfile(raw_dir, 'y_lstm_sig.mat'));
e_pid = load_structure(fullfile(raw_dir, 'e_pid.mat'));
e_lstm = load_structure(fullfile(raw_dir, 'e_lstm.mat'));
check_flags = load_structure(fullfile(raw_dir, 'check_flags.mat'));

waveform_path = fullfile(report_dir, 'waveforms.png');
error_path = fullfile(report_dir, 'errors.png');
check_csv_path = fullfile(report_dir, 'check_flags.csv');
results_md_path = fullfile(report_dir, 'results.md');

create_waveform_plot(ref_sig, y_pid_sig, y_lstm_sig, waveform_path);
create_error_plot(e_pid, e_lstm, error_path);
write_check_csv(check_flags, check_csv_path);
write_results_markdown(results_md_path, metrics, cfg, config_path, waveform_path, error_path, check_csv_path);

end

function structure = load_structure(path)
if ~exist(path, 'file') %#ok<EXIST>
    error('export_report:MissingFile', 'Expected MAT file %s.', path);
end
payload = load(path);
if isfield(payload, 'time') && isfield(payload, 'signals')
    structure = payload;
else
    fields = fieldnames(payload);
    if numel(fields) == 1
        structure = payload.(fields{1});
    else
        error('export_report:InvalidMatFile', ...
            'MAT file %s must contain time/signals fields.', path);
    end
end
structure.time = double(structure.time(:));
structure.signals.values = double(structure.signals.values);
end

function create_waveform_plot(ref_sig, y_pid_sig, y_lstm_sig, path)
fig = figure('Visible', 'off', 'Position', [100 100 960 540], 'Renderer', 'painters');
hold on;
colors = lines(3);
plot_signal(ref_sig, ref_sig.signals.values, colors(1, :), '--', 'Reference');
plot_signal(y_pid_sig, y_pid_sig.signals.values, colors(2, :), '-', 'PID Output');
plot_signal(y_lstm_sig, y_lstm_sig.signals.values, colors(3, :), '-', 'LSTM Output');
legend('Location', 'best');
xlabel('Time (s)');
ylabel('Amplitude');
title('Reference vs. Controller Outputs');
grid on;
exportgraphics(fig, path, 'Resolution', 150, 'BackgroundColor', 'white');
close(fig);
end

function create_error_plot(e_pid, e_lstm, path)
fig = figure('Visible', 'off', 'Position', [100 100 960 540], 'Renderer', 'painters');
subplot(2, 1, 1);
hold on;
plot_signal(e_pid, e_pid.signals.values, [0.8500 0.3250 0.0980], '-', 'e_{pid}');
title('PID Error Components');
xlabel('Time (s)');
ylabel('Error');
grid on;
legend(cellstr(compose_channel_labels(size(e_pid.signals.values, 2))), 'Location', 'best');

subplot(2, 1, 2);
hold on;
plot_signal(e_lstm, e_lstm.signals.values, [0.4940 0.1840 0.5560], '-', 'e_{lstm}');
title('LSTM Error Components');
xlabel('Time (s)');
ylabel('Error');
grid on;
legend(cellstr(compose_channel_labels(size(e_lstm.signals.values, 2))), 'Location', 'best');

exportgraphics(fig, path, 'Resolution', 150, 'BackgroundColor', 'white');
close(fig);
end

function write_check_csv(check_flags, path)
values = check_flags.signals.values;
if size(values, 2) < 2
    error('export_report:InvalidCheckFlags', ...
        'check_flags signal must contain at least alarm and countK columns.');
end
T = table(check_flags.time, values(:, 1), values(:, 2), ...
    'VariableNames', {'time', 'alarm', 'countK'});
writetable(T, path);
end

function write_results_markdown(path, metrics, cfg, config_path, waveform_path, error_path, check_csv_path)
fid = fopen(path, 'w');
if fid == -1
    error('export_report:FileOpenFailed', 'Unable to open %s for writing.', path);
end
cleanup = onCleanup(@() fclose(fid));

fprintf(fid, '# Time-Domain Report\n\n');
fprintf(fid, '## Configuration\n');
fprintf(fid, '- Config: `%s`\n', cfg_path_relative(config_path));
fprintf(fid, '- Run ID: `%s`\n', cfg.simulation.run_id);
fprintf(fid, '- Model: `%s`\n', cfg.model_name);
if isfield(metrics, 'metadata') && isfield(metrics.metadata, 'git_hash')
    fprintf(fid, '- Git hash: `%s`\n', metrics.metadata.git_hash);
end
fprintf(fid, '\n');

fprintf(fid, '## Integral Metrics\n');
fprintf(fid, '| Metric | PID | LSTM |\n');
fprintf(fid, '| --- | --- | --- |\n');
fprintf(fid, '| IAE | %.12g | %.12g |\n', metrics.iae.pid, metrics.iae.lstm);
fprintf(fid, '| ISE | %.12g | %.12g |\n', metrics.ise.pid, metrics.ise.lstm);
fprintf(fid, '| ITAE | %.12g | %.12g |\n', metrics.itae.pid, metrics.itae.lstm);
fprintf(fid, '\n');

time_fields = {'RiseTime', 'SettlingTime', 'Overshoot', 'Peak', 'PeakTime'};
labels = {'Rise time (s)', 'Settling time (s)', 'Overshoot (%)', 'Peak', 'Peak time (s)'};
fprintf(fid, '## Time-Domain Characteristics\n');
fprintf(fid, '| Metric | PID | LSTM |\n');
fprintf(fid, '| --- | --- | --- |\n');
for i = 1:numel(time_fields)
    field = time_fields{i};
    label = labels{i};
    pid_val = metrics.time_domain.pid.(field);
    lstm_val = metrics.time_domain.lstm.(field);
    fprintf(fid, '| %s | %.12g | %.12g |\n', label, pid_val, lstm_val);
end
fprintf(fid, '\n');

fprintf(fid, '## Timing Error\n');
fprintf(fid, '| Controller | Timing error sum (s) |\n');
fprintf(fid, '| --- | --- |\n');
fprintf(fid, '| PID | %.12g |\n', metrics.timing_error_sum.pid);
fprintf(fid, '| LSTM | %.12g |\n', metrics.timing_error_sum.lstm);
fprintf(fid, '\n');

fprintf(fid, '## Artifacts\n');
fprintf(fid, '- Waveforms: `%s`\n', relative_to_report(path, waveform_path));
fprintf(fid, '- Errors: `%s`\n', relative_to_report(path, error_path));
fprintf(fid, '- Check flags: `%s`\n', relative_to_report(path, check_csv_path));

clear cleanup;
end

function plot_signal(signal, values, base_color, line_style, label_prefix)
if size(values, 2) == 1
    stairs(signal.time, values, 'Color', base_color, 'LineStyle', line_style, 'LineWidth', 1.2, ...
        'DisplayName', label_prefix);
else
    for idx = 1:size(values, 2)
        channel_label = sprintf('%s_%d', label_prefix, idx);
        shade = 0.7 + 0.3 * (idx - 1) / max(1, size(values, 2) - 1);
        stairs(signal.time, values(:, idx), 'Color', base_color * shade, 'LineStyle', line_style, ...
            'LineWidth', 1.0, 'DisplayName', channel_label);
    end
end
end

function labels = compose_channel_labels(count)
labels = strings(count, 1);
for i = 1:count
    labels(i) = sprintf('channel_%d', i);
end
end

function rel = cfg_path_relative(path_value)
if nargin == 0 || isempty(path_value)
    rel = 'config/sim_config.json';
else
    rel = path_value;
end
end

function rel = relative_to_report(md_path, target_path)
md_dir = fileparts(md_path);
prefix = [md_dir filesep];
if strncmp(target_path, prefix, numel(prefix))
    rel = target_path(numel(prefix)+1:end);
else
    rel = target_path;
end
if isempty(rel)
    rel = '.';
end
end
