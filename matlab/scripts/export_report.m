%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

function export_report(metrics, artifactsDir)
%EXPORT_REPORT Persist simulation metrics to JSON, MAT, and tabular summaries.
%
%   EXPORT_REPORT(METRICS, ARTIFACTSDIR) writes the metrics struct to
%   metrics.json and metrics.mat inside the specified artifacts directory.
%   In addition, it materialises a comparative table between the LSTM and
%   PID controllers covering IAE/ISE/ITAE, rise time, settling time,
%   overshoot percentage, and steady-state error. A CSV and Markdown view of
%   the table are produced to simplify report inclusion.

arguments
    metrics (1, 1) struct
    artifactsDir (1, 1) string = make_artifacts();
end

addpath(fullfile(fileparts(mfilename('fullpath')), '..', 'util'));

if exist(artifactsDir, 'dir') ~= 7
    mkdir(artifactsDir);
end

jsonText = jsonencode(metrics, 'PrettyPrint', true);
fid = fopen(fullfile(artifactsDir, 'metrics.json'), 'w');
if fid == -1
    error('export_report:CannotOpenJSON', ...
        'Unable to open metrics.json for writing under %s.', artifactsDir);
end
jsonCleaner = onCleanup(@() fclose(fid));
fwrite(fid, jsonText, 'char');
clear jsonCleaner;

save(fullfile(artifactsDir, 'metrics.mat'), 'metrics', '-v7');

comparisonTable = build_comparison_table(metrics);

csvPath = fullfile(artifactsDir, 'metrics_comparison.csv');
writetable(comparisonTable, csvPath);

markdownPath = fullfile(artifactsDir, 'metrics_comparison.md');
write_markdown_table(comparisonTable, markdownPath, metrics);
end

function tbl = build_comparison_table(metrics)
rows = {
    'IAE', metrics.LSTM.IAE, metrics.PID.IAE;
    'ISE', metrics.LSTM.ISE, metrics.PID.ISE;
    'ITAE', metrics.LSTM.ITAE, metrics.PID.ITAE;
    'RiseTime', metrics.LSTM.RiseTime, metrics.PID.RiseTime;
    'SettlingTime', metrics.LSTM.SettlingTime, metrics.PID.SettlingTime;
    'OvershootPct', metrics.LSTM.OvershootPct, metrics.PID.OvershootPct;
    'SteadyStateError', metrics.LSTM.SteadyStateError, metrics.PID.SteadyStateError;
    };

lstmVals = cell2mat(rows(:, 2));
pidVals = cell2mat(rows(:, 3));
deltaVals = lstmVals - pidVals;

tbl = cell2table(rows, ...
    'VariableNames', {'Metric', 'LSTM', 'PID'});
tbl.Delta = deltaVals;
end

function write_markdown_table(tbl, path, metrics)
fid = fopen(path, 'w');
if fid == -1
    error('export_report:CannotOpenMarkdown', ...
        'Unable to open %s for writing.', path);
end
cleaner = onCleanup(@() fclose(fid));

fprintf(fid, '| Metric | LSTM | PID | LSTM - PID |\n');
fprintf(fid, '|---|---:|---:|---:|\n');
for rowIdx = 1:height(tbl)
    line = sprintf('| %s | %s | %s | %s |\n', ...
        tbl.Metric{rowIdx}, ...
        format_value(tbl.LSTM(rowIdx)), ...
        format_value(tbl.PID(rowIdx)), ...
        format_value(tbl.Delta(rowIdx)));
    fprintf(fid, '%s', line);
end

if isfield(metrics, 'common') && isfield(metrics.common, 'tol')
    fprintf(fid, '\nSettling band: ±%.2f%% of the final step amplitude.\n', ...
        metrics.common.tol * 100);
end
end

function txt = format_value(val)
if isnan(val)
    txt = 'NaN';
elseif abs(val) >= 1e3 || abs(val) < 1e-3
    txt = sprintf('%.6e', val);
else
    txt = sprintf('%.6f', val);
end
end
