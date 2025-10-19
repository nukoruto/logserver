%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

function export_report(metrics, artifactsDir)
%EXPORT_REPORT Persist simulation metrics to JSON and MAT artifacts.
%
%   EXPORT_REPORT(METRICS, ARTIFACTSDIR) writes the metrics struct to
%   metrics.json and metrics.mat inside the specified artifacts directory.

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
cleaner = onCleanup(@() fclose(fid));
fwrite(fid, jsonText, 'char');

save(fullfile(artifactsDir, 'metrics.mat'), 'metrics', '-v7');
end
