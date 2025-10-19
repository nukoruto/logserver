"""Create the standard MATLAB project scaffold for Simulink/LSTM comparison.

This utility adheres to SRS.md and CONSTRAINTS.md by preparing the MATLAB
side folders, configuration, and helper scripts required for reproducible
simulations. Run from the repository root.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import subprocess
from pathlib import Path
from typing import Dict


REPO_ROOT = Path(__file__).resolve().parent.parent
MATLAB_ROOT = REPO_ROOT / "matlab"


def get_git_hash() -> str:
    """Return the short git hash, or 'nogit' if unavailable."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return "nogit"
    return result.stdout.strip() or "nogit"


HEADER = "%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.\n"


def matlab_scripts() -> Dict[Path, str]:
    """Return mapping of MATLAB script paths to their contents."""
    util_dir = MATLAB_ROOT / "util"
    scripts_dir = MATLAB_ROOT / "scripts"
    tests_dir = MATLAB_ROOT / "tests"

    contents: Dict[Path, str] = {}

    contents[scripts_dir / "build_pid_vs_lstm_model.m"] = HEADER + """
function build_pid_vs_lstm_model(configPath)
%BUILD_PID_VS_LSTM_MODEL Generate or update the Simulink model for PID vs LSTM comparison.
%   BUILD_PID_VS_LSTM_MODEL(CONFIGPATH) reads simulation parameters from the
%   JSON configuration file and programmatically generates a Simulink model
%   that compares a baseline PID controller with an LSTM-based controller.
%
%   The function is idempotent and overwrites existing models with the same
%   name. See matlab/config/sim_config.json for required fields.
%
%   Example:
%       build_pid_vs_lstm_model('../config/sim_config.json');
%
%   This script does not require MATLAB toolboxes beyond Simulink and the
%   Deep Learning Toolbox. It builds a placeholder LSTM block that can be
%   replaced with an imported network using importNetworkFromONNX.

arguments
    configPath (1, 1) string = fullfile(fileparts(mfilename('fullpath')), '..', 'config', 'sim_config.json');
end

config = jsondecode(fileread(configPath));
modelName = 'pid_vs_lstm';
modelPath = fullfile(fileparts(mfilename('fullpath')), '..', 'models', modelName + ".slx");

if bdIsLoaded(modelName)
    close_system(modelName, 0);
end
if exist(modelPath, 'file') == 4
    delete(modelPath);
end

new_system(modelName);
open_system(modelName);

try
    % Plant block
    add_block('simulink/Continuous/Transfer Fcn', modelName + '/Plant', ...
        'Numerator', mat2str([config.plant.K]), ...
        'Denominator', mat2str([config.plant.tau 1]));
    % PID Controller
    add_block('simulink/Continuous/PID Controller', modelName + '/PID', ...
        'P', num2str(config.pid.Kp), 'I', num2str(config.pid.Ki), 'D', num2str(config.pid.Kd));
    % LSTM placeholder subsystem
    add_block('simulink/Ports & Subsystems/Subsystem', modelName + '/LSTM_Controller');
    add_block('simulink/Commonly Used Blocks/From Workspace', modelName + '/Reference');
    add_block('simulink/Commonly Used Blocks/Sum', modelName + '/Sum', 'Inputs', '+-');
    add_block('simulink/Commonly Used Blocks/Scope', modelName + '/Scope');
    add_block('simulink/Signal Routing/Mux', modelName + '/Mux');
    add_block('simulink/Commonly Used Blocks/To Workspace', modelName + '/ToWorkspace', ...
        'VariableName', 'simout', 'SaveFormat', 'StructureWithTime');

    % Wire up signals
    add_line(modelName, 'Reference/1', 'Sum/1');
    add_line(modelName, 'Plant/1', 'Scope/1');
    add_line(modelName, 'Sum/1', 'PID/1');
    add_line(modelName, 'PID/1', 'Plant/1');
    add_line(modelName, 'Plant/1', 'Mux/1');
    add_line(modelName, 'PID/1', 'Mux/2');
    add_line(modelName, 'Reference/1', 'Mux/3');
    add_line(modelName, 'Mux/1', 'ToWorkspace/1');

    % Connect LSTM placeholder (not wired by default to avoid algebraic loops)
    add_line(modelName, 'Reference/1', 'LSTM_Controller/1');
catch err
    close_system(modelName, 0);
    rethrow(err);
end

save_system(modelName, modelPath);
close_system(modelName);
end
"""

    contents[scripts_dir / "prepare_timeseries.m"] = HEADER + """
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
"""

    contents[scripts_dir / "run_simulation.m"] = HEADER + """
function simOut = run_simulation(modelPath, configPath)
%RUN_SIMULATION Execute the Simulink model and return logged outputs.
%
%   SIMOUT = RUN_SIMULATION(MODELPATH, CONFIGPATH) loads the Simulink model,
%   applies configuration parameters, runs the simulation, and returns the
%   Simulink.SimulationOutput.

arguments
    modelPath (1, 1) string = fullfile(fileparts(mfilename('fullpath')), '..', 'models', 'pid_vs_lstm.slx');
    configPath (1, 1) string = fullfile(fileparts(mfilename('fullpath')), '..', 'config', 'sim_config.json');
end

if exist(modelPath, 'file') ~= 4
    error('run_simulation:MissingModel', 'Model file %s does not exist. Run build_pid_vs_lstm_model first.', modelPath);
end

addpath(fullfile(fileparts(mfilename('fullpath')), '..', 'util'));

config = jsondecode(fileread(configPath));
load_system(modelPath);
modelName = bdroot(modelPath);

set_param(modelName, 'StopTime', num2str(config.simulation.stop_time));
set_param(modelName + "/Reference", 'VariableName', config.signals.reference);

simOut = sim(modelName, 'SaveOutput', 'on', 'ReturnWorkspaceOutputs', 'on');
end
"""

    contents[scripts_dir / "analyze_time_domain.m"] = HEADER + """
function metrics = analyze_time_domain(simOut, settleBand)
%ANALYZE_TIME_DOMAIN Compute time-domain control metrics from simulation output.
%
%   METRICS = ANALYZE_TIME_DOMAIN(SIMOUT, SETTLEBAND) calculates rise time,
%   overshoot, settling time, steady-state error, and integral absolute
%   error metrics from the SimulationOutput struct.

arguments
    simOut Simulink.SimulationOutput
    settleBand (1, 1) double {mustBePositive} = 0.02
end

simData = simOut.simout;
timeVec = simData.time;
signals = simData.signals;

plantIdx = 1;
refIdx = numel(signals);

response = double(signals(plantIdx).values);
ref = double(signals(refIdx).values);

metrics = struct();
metrics.rise_time = time_to_value(response, ref, timeVec, 0.9);
metrics.overshoot_pct = (max(response) - ref(end)) / ref(end) * 100;
metrics.settling_time = settling_time(response, ref, timeVec, settleBand);
metrics.steady_state_error = abs(response(end) - ref(end));
metrics.IAE = trapz(timeVec, abs(response - ref));
end

function tRise = time_to_value(response, reference, timeVec, targetFraction)
    target = targetFraction * reference(end);
    idx = find(response >= target, 1, 'first');
    if isempty(idx)
        tRise = NaN;
    else
        tRise = timeVec(idx) - timeVec(1);
    end
end

function tSettle = settling_time(response, reference, timeVec, band)
    finalValue = reference(end);
    lower = finalValue * (1 - band);
    upper = finalValue * (1 + band);
    idx = find(response < lower | response > upper, 1, 'last');
    if isempty(idx)
        tSettle = 0;
    else
        tSettle = timeVec(idx) - timeVec(1);
    end
end
"""

    contents[scripts_dir / "export_report.m"] = HEADER + """
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
"""

    contents[scripts_dir / "run_all.m"] = HEADER + """
function artifactsDir = run_all()
%RUN_ALL End-to-end execution pipeline for Simulink comparison.
%   RUN_ALL orchestrates model generation, simulation, analysis, and report
%   export. Returns the artifacts directory containing generated files.

configPath = fullfile(fileparts(mfilename('fullpath')), '..', 'config', 'sim_config.json');
addpath(fullfile(fileparts(mfilename('fullpath')), '..', 'util'));
outputDir = make_artifacts();

build_pid_vs_lstm_model(configPath);
simOut = run_simulation();
metrics = analyze_time_domain(simOut);
export_report(metrics, outputDir);

artifactsDir = outputDir;
end
"""

    contents[util_dir / "make_artifacts.m"] = HEADER + """
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
"""

    contents[util_dir / "choose_info_fn.m"] = HEADER + """
function [info_fn, method] = choose_info_fn(time_vector, reference, settling_threshold)
%CHOOSE_INFO_FN Select appropriate transient metric evaluator based on input type.
%   [FN, METHOD] = CHOOSE_INFO_FN(TIME_VECTOR, REFERENCE, SETTLING_THRESHOLD)
%   returns a function handle FN that accepts a response signal and
%   delegates to either STEPINFO or LSIMINFO depending on whether the
%   reference resembles a step input. METHOD is the string identifier of
%   the chosen function.

arguments
    time_vector (:, 1) double
    reference (:, 1) double
    settling_threshold (1, 1) double {mustBePositive}
end

if numel(time_vector) ~= numel(reference)
    error('choose_info_fn:LengthMismatch', ...
        'Time vector and reference signal must have identical lengths.');
end

if is_step_like(reference)
    method = "stepinfo";
    final_value = reference(end);
    info_fn = @(response) stepinfo(response, time_vector, final_value, ...
        'SettlingTimeThreshold', settling_threshold);
else
    method = "lsiminfo";
    info_fn = @(response) lsiminfo(response, time_vector, reference, ...
        'SettlingTimeThreshold', settling_threshold);
end
end

function flag = is_step_like(reference)
if isempty(reference)
    flag = true;
    return;
end
ref = reference(:);
scale = max(1.0, max(abs(ref)));
tol = 1e-9 * scale;
deltas = diff(ref);
change_idx = find(abs(deltas) > tol);
if isempty(change_idx)
    flag = true;
    return;
end
first_change = change_idx(1);
last_change = change_idx(end);
if first_change ~= last_change
    flag = false;
    return;
end
pre_segment = ref(1:first_change);
post_segment = ref(first_change+1:end);
flag = max(abs(pre_segment - pre_segment(1))) <= tol && ...
       max(abs(post_segment - post_segment(1))) <= tol;
end
"""

    contents[util_dir / "k_of_n_latch.m"] = HEADER + """
function [alarm, countK] = k_of_n_latch(viol, K, N, hyst_up, hyst_down)
%K_OF_N_LATCH Sliding-window K-of-N latch with hysteresis for MATLAB Function blocks.
%   [ALARM, COUNTK] = K_OF_N_LATCH(VIOL, K, N, HYST_UP, HYST_DOWN) raises
%   ALARM when at least K (or the hysteresis-up threshold) violations are
%   observed within the latest N samples. The latch resets when the
%   violation count falls to or below the hysteresis-down threshold.
%   COUNTK returns the current count of violations in the active window.
%
%   HYST_UP/HYST_DOWN can be specified either as counts (>= 1) or as ratios
%   (<= 1) relative to N.
%#codegen
arguments
    viol (1, 1) double
    K (1, 1) double {mustBePositive, mustBeInteger}
    N (1, 1) double {mustBePositive, mustBeInteger}
    hyst_up (1, 1) double {mustBeNonnegative}
    hyst_down (1, 1) double {mustBeNonnegative}
end

persistent buffer;
persistent index;
persistent count;
persistent filled;
persistent latched;

if isempty(buffer) || numel(buffer) ~= N
    buffer = false(N, 1);
    index = 1;
    count = 0;
    filled = 0;
    latched = false;
end

viol_flag = viol ~= 0;
if filled < N
    buffer(index) = viol_flag;
    count = count + double(viol_flag);
    filled = filled + 1;
else
    removed = buffer(index);
    buffer(index) = viol_flag;
    count = count + double(viol_flag) - double(removed);
end

index = index + 1;
if index > N
    index = 1;
end

set_threshold = resolve_threshold(hyst_up, K, N);
release_threshold = resolve_threshold(hyst_down, 0, N);
release_threshold = min(release_threshold, set_threshold - 1);
release_threshold = max(release_threshold, 0);

if ~latched
    if count >= set_threshold
        latched = true;
    end
else
    if count <= release_threshold
        latched = false;
    end
end

alarm = latched;
countK = count;
end

function threshold = resolve_threshold(value, base, N)
if value <= 1
    threshold = ceil(value * N);
else
    threshold = ceil(value);
end
threshold = max(base, threshold);
threshold = min(N, threshold);
end
"""

    contents[util_dir / "save_structure_with_time.m"] = HEADER + """
function save_structure_with_time(outputPath, dataStruct)
%SAVE_STRUCTURE_WITH_TIME Save struct with time field enforcing double precision.
%
%   SAVE_STRUCTURE_WITH_TIME(OUTPUTPATH, DATASTRUCT) validates that
%   DATASTRUCT contains a 'Time' field and saves it as a MAT-file using
%   double precision.

arguments
    outputPath (1, 1) string
    dataStruct (1, 1) struct
end

if ~isfield(dataStruct, 'Time')
    error('save_structure_with_time:MissingTime', 'dataStruct must contain a Time field.');
end

dataStruct.Time = double(dataStruct.Time);
fields = fieldnames(dataStruct);
for idx = 1:numel(fields)
    fieldName = fields{idx};
    if isstruct(dataStruct.(fieldName)) && isfield(dataStruct.(fieldName), 'Time')
        dataStruct.(fieldName).Time = double(dataStruct.(fieldName).Time);
    end
end

save(outputPath, '-struct', 'dataStruct', '-v7');
end
"""

    contents[tests_dir / "test_pid_vs_lstm.m"] = HEADER + """
classdef test_pid_vs_lstm < matlab.unittest.TestCase
    %TEST_PID_VS_LSTM Basic smoke tests for the Simulink workflow scripts.

    methods (Test)
        function test_make_artifacts(testCase)
            artifactsDir = make_artifacts(tempdir);
            testCase.assertTrue(isfolder(artifactsDir));
        end

        function test_choose_info_fn_step(testCase)
            t = (0:4)';
            ref = [zeros(2, 1); ones(3, 1)];
            [fn, method] = choose_info_fn(t, ref, 0.02);
            testCase.verifyEqual(method, "stepinfo");
            info = fn(ref);
            testCase.verifyClass(info, 'struct');
        end

        function test_choose_info_fn_lsim(testCase)
            t = (0:4)';
            ref = sin(t);
            [fn, method] = choose_info_fn(t, ref, 0.02);
            testCase.verifyEqual(method, "lsiminfo");
            resp = ref;
            info = fn(resp);
            testCase.verifyClass(info, 'struct');
        end

        function test_k_of_n_latch_hysteresis(testCase)
            clear k_of_n_latch; %#ok<CLFUNC>
            inputs = [0 1 1 1 0 0 0];
            alarms = false(size(inputs));
            counts = zeros(size(inputs));
            for idx = 1:numel(inputs)
                [alarms(idx), counts(idx)] = k_of_n_latch(inputs(idx), 3, 5, 3, 1);
            end
            testCase.verifyTrue(alarms(4));
            testCase.verifyFalse(alarms(end));
            testCase.verifyGreaterThanOrEqual(max(counts), 3);
        end
    end
end
"""

    return contents


def write_json_config(path: Path) -> str:
    config = {
        "simulation": {
            "Ts": 0.01,
            "stop_time": 10.0,
            "forceUniformGrid": True,
            "settle_band": 0.02,
        },
        "plant": {"K": 1.0, "tau": 0.5},
        "pid": {"Kp": 1.2, "Ki": 0.8, "Kd": 0.05},
        "lstm": {
            "sequence_length": 50,
            "hidden_units": 128,
            "delta_t_normalization": "robust_z",
        },
        "signals": {
            "reference": "reference_signal",
            "disturbance": "disturbance_signal",
        },
        "threshold": {
            "method": "quantile",
            "quantile": 0.99,
            "k_of_n": {"k": 3, "n": 5, "release_ratio": 0.5},
            "hysteresis": 1.2,
        },
        "gpu": {
            "mode_env": "GPU_MODE",
            "modes": {
                "ada6000": {"cuda_visible_devices": "0"},
                "4060": {"cuda_visible_devices": "1"},
            },
        },
    }
    return json.dumps(config, indent=2) + "\n"


def ensure_directories(force: bool = False) -> None:
    matlab_dirs = [
        MATLAB_ROOT,
        MATLAB_ROOT / "scripts",
        MATLAB_ROOT / "models",
        MATLAB_ROOT / "util",
        MATLAB_ROOT / "config",
        MATLAB_ROOT / "tests",
    ]
    for directory in matlab_dirs:
        directory.mkdir(parents=True, exist_ok=True)

    artifacts_sim = REPO_ROOT / "artifacts" / "sim"
    artifacts_sim.mkdir(parents=True, exist_ok=True)
    gitkeep = artifacts_sim / ".gitkeep"
    if not gitkeep.exists():
        gitkeep.write_text("# Keep artifacts/sim directory versioned.\n", encoding="utf-8")

    config_path = MATLAB_ROOT / "config" / "sim_config.json"
    if force or not config_path.exists():
        config_path.write_text(write_json_config(config_path), encoding="utf-8")

    gitignore_models = MATLAB_ROOT / "models" / ".gitignore"
    if force or not gitignore_models.exists():
        gitignore_models.write_text("pid_vs_lstm.slx\n", encoding="utf-8")

    for path, content in matlab_scripts().items():
        if force or not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing files with the scaffold versions.",
    )
    args = parser.parse_args()

    ensure_directories(force=args.force)
    git_hash = get_git_hash()
    timestamp = _dt.datetime.now(_dt.UTC).isoformat(timespec="seconds")
    print(f"MATLAB scaffold ensured at {MATLAB_ROOT} (hash={git_hash}, time={timestamp})")


if __name__ == "__main__":
    main()
