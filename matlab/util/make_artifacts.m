%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

function artifactsDir = make_artifacts(rootDir)
%MAKE_ARTIFACTS Create a timestamped artifact directory containing git hash.
%
%   ARTIFACTSDIR = MAKE_ARTIFACTS(ROOTDIR) creates (if necessary) and returns
%   the path to an artifacts directory under ROOTDIR (default:
%   <repo>/artifacts/sim). The directory name embeds the UTC timestamp and
%   current git hash for reproducibility.

if nargin < 1 || strlength(rootDir) == 0
    rootDir = fullfile(fileparts(mfilename('fullpath')), '..', '..', 'artifacts', 'sim');
end

if exist(rootDir, 'dir') ~= 7
    mkdir(rootDir);
end

timeStamp = datetime('now', 'TimeZone', 'UTC', 'Format', 'yyyyMMdd''T''HHmmss');
[status, gitHash] = system('git rev-parse --short HEAD');
if status ~= 0
    gitHash = 'nogit';
else
    gitHash = strtrim(gitHash);
end

dirName = sprintf('%s_%s', char(timeStamp), gitHash);
artifactsDir = fullfile(rootDir, dirName);
if exist(artifactsDir, 'dir') ~= 7
    mkdir(artifactsDir);
end
end
