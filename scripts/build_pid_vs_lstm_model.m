function build_pid_vs_lstm_model(config_path)
%BUILD_PID_VS_LSTM_MODEL Programmatically assemble the pid_vs_lstm model.
%   BUILD_PID_VS_LSTM_MODEL(CONFIG_PATH) regenerates the Simulink model so
%   that manual editing is unnecessary. The script configures model-level
%   solver options, places all blocks, sets parameters, and connects lines
%   according to the JSON configuration.
arguments
    config_path (1, :) char = 'config/sim_config.json'
end

cfg = jsondecode(fileread(config_path));
model_name = cfg.model_name;
model_path = cfg.model_path;
Ts = cfg.Ts;
category_count = cfg.category_count;

if bdIsLoaded(model_name)
    close_system(model_name, 0);
end
if exist(model_path, 'file') %#ok<EXIST>
    delete(model_path);
end
new_system(model_name);
open_system(model_name);

set_param(model_name, ...
    'SolverType', 'Fixed-step', ...
    'Solver', 'FixedStepDiscrete', ...
    'FixedStep', num2str(Ts, '%.12g'), ...
    'StartTime', '0.0', ...
    'StopTime', 'inf', ...
    'AbsTol', 'auto', ...
    'RelTol', '1e-4', ...
    'ReturnWorkspaceOutputs', 'on');

% === Inputs ===
ref_in = create_block(model_name, 'ref_in', 'simulink/Sources/From Workspace', ...
    [30 30 120 80], struct( ...
        'VariableName', cfg.signals.ref_variable, ...
        'DataFormat', 'StructureWithTime', ...
        'OutputAfterFinalValue', 'Holding final value'));
ref_zoh = create_block(model_name, 'ref_zoh', 'simulink/Discrete/Zero-Order Hold', ...
    [150 30 240 80], struct('SampleTime', num2str(Ts, '%.12g')));
ref_spec = create_block(model_name, 'ref_spec', 'simulink/Signal Attributes/Signal Specification', ...
    [270 30 360 80], struct('OutDataTypeStr', 'double', 'Dimensions', num2str(category_count)));

lstm_in = create_block(model_name, 'lstm_in', 'simulink/Sources/From Workspace', ...
    [30 150 120 200], struct( ...
        'VariableName', cfg.signals.lstm_variable, ...
        'DataFormat', 'StructureWithTime', ...
        'OutputAfterFinalValue', 'Holding final value'));
lstm_zoh = create_block(model_name, 'lstm_zoh', 'simulink/Discrete/Zero-Order Hold', ...
    [150 150 240 200], struct('SampleTime', num2str(Ts, '%.12g')));
lstm_spec = create_block(model_name, 'lstm_spec', 'simulink/Signal Attributes/Signal Specification', ...
    [270 150 360 200], struct('OutDataTypeStr', 'double', 'Dimensions', num2str(category_count)));

lstm_terminal = 'lstm_spec';
if isfield(cfg, 'rate_transition') && isfield(cfg.rate_transition, 'enable') && cfg.rate_transition.enable
    sample_time = resolve_sample_time(cfg.rate_transition.out_sample_time, Ts);
    lstm_rate = create_block(model_name, 'lstm_rate', 'simulink/Signal Attributes/Rate Transition', ...
        [390 150 480 200], struct('OutPortSampleTime', sample_time));
    lstm_terminal = 'lstm_rate';
    add_line(model_name, 'lstm_spec/1', 'lstm_rate/1', 'autorouting', 'on');
end

% === PID branch ===
pid_sum = create_block(model_name, 'pid_error_sum', 'simulink/Math Operations/Sum', ...
    [390 30 480 80], struct('Inputs', '+-'));
pid_block = add_pid_block(model_name, cfg.pid, Ts, [510 20 620 90]);
plant_block = add_discrete_plant(model_name, cfg.plant, Ts, [640 20 750 90]);
pid_spec = create_block(model_name, 'pid_spec', 'simulink/Signal Attributes/Signal Specification', ...
    [780 20 890 90], struct('OutDataTypeStr', 'double', 'Dimensions', num2str(category_count), 'SignalName', cfg.signals.pid_variable));
y_pid_sink = add_to_workspace(model_name, 'y_pid_sink', cfg.signals.pid_variable, [910 30 1020 80]);

% === Direct sinks for inputs ===
ref_sink = add_to_workspace(model_name, 'ref_sink', cfg.signals.ref_variable, [390 -60 500 -10]);
lstm_sink = add_to_workspace(model_name, 'y_lstm_sink', cfg.signals.lstm_variable, [520 150 630 200]);

% === Error computations ===
pid_error = create_block(model_name, 'pid_error', 'simulink/Math Operations/Sum', ...
    [520 120 610 170], struct('Inputs', '+-'));
pid_error_sink = add_to_workspace(model_name, 'pid_error_sink', 'e_pid', [640 120 750 170]);
lstm_error = create_block(model_name, 'lstm_error', 'simulink/Math Operations/Sum', ...
    [520 200 610 250], struct('Inputs', '+-'));
lstm_error_sink = add_to_workspace(model_name, 'lstm_error_sink', 'e_lstm', [640 200 750 250]);

% === Metrics subsystems ===
pid_metrics = create_metrics_subsystem(model_name, 'pid_metrics', Ts, [780 120 900 320]);
lstm_metrics = create_metrics_subsystem(model_name, 'lstm_metrics', Ts, [780 200 900 400]);

% === Monitoring blocks ===
check_block = create_block(model_name, 'step_checker', 'simulink/Model Verification/Check Step Response Characteristics', ...
    [780 150 890 230], struct( ...
        'SettlingTime', num2str(cfg.check.settling_time, '%.12g'), ...
        'SettlingTimePercent', num2str(cfg.check.settling_percentage, '%.12g'), ...
        'RiseTime', num2str(cfg.check.rise_time, '%.12g'), ...
        'Overshoot', num2str(cfg.check.overshoot, '%.12g')));
k_block = create_block(model_name, 'k_of_n_latch', 'simulink/User-Defined Functions/MATLAB Function', ...
    [910 150 1050 260], struct());
set_param(k_block, 'MATLABFcn', build_k_of_n_script(cfg.check.k_of_n));
check_sink = add_to_workspace(model_name, 'check_sink', 'check_flags', [1080 170 1190 220]);

% === Connections ===
add_line(model_name, 'ref_in/1', 'ref_zoh/1', 'autorouting', 'on');
add_line(model_name, 'ref_zoh/1', 'ref_spec/1', 'autorouting', 'on');
add_line(model_name, 'ref_spec/1', 'pid_error_sum/1', 'autorouting', 'on');
add_line(model_name, 'ref_spec/1', 'ref_sink/1', 'autorouting', 'on');
add_line(model_name, 'ref_spec/1', 'pid_error/1', 'autorouting', 'on');
add_line(model_name, 'ref_spec/1', 'lstm_error/1', 'autorouting', 'on');

add_line(model_name, 'lstm_in/1', 'lstm_zoh/1', 'autorouting', 'on');
add_line(model_name, 'lstm_zoh/1', 'lstm_spec/1', 'autorouting', 'on');
if strcmp(lstm_terminal, 'lstm_rate')
    add_line(model_name, 'lstm_rate/1', 'lstm_sink/1', 'autorouting', 'on');
    add_line(model_name, 'lstm_rate/1', 'lstm_error/2', 'autorouting', 'on');
else
    add_line(model_name, 'lstm_spec/1', 'lstm_sink/1', 'autorouting', 'on');
    add_line(model_name, 'lstm_spec/1', 'lstm_error/2', 'autorouting', 'on');
end

add_line(model_name, 'pid_error_sum/1', 'pid_controller/1', 'autorouting', 'on');
add_line(model_name, 'pid_controller/1', 'plant/1', 'autorouting', 'on');
add_line(model_name, 'plant/1', 'pid_spec/1', 'autorouting', 'on');
add_line(model_name, 'pid_spec/1', 'y_pid_sink/1', 'autorouting', 'on');
add_line(model_name, 'pid_spec/1', 'pid_error_sum/2', 'autorouting', 'on');
add_line(model_name, 'pid_spec/1', 'pid_error/2', 'autorouting', 'on');
add_line(model_name, 'pid_spec/1', 'step_checker/1', 'autorouting', 'on');

add_line(model_name, 'pid_error/1', 'pid_error_sink/1', 'autorouting', 'on');
add_line(model_name, 'lstm_error/1', 'lstm_error_sink/1', 'autorouting', 'on');
add_line(model_name, 'pid_error/1', 'pid_metrics/1', 'autorouting', 'on');
add_line(model_name, 'lstm_error/1', 'lstm_metrics/1', 'autorouting', 'on');
add_line(model_name, 'step_checker/1', 'k_of_n_latch/1', 'autorouting', 'on');
add_line(model_name, 'k_of_n_latch/1', 'check_sink/1', 'autorouting', 'on');

% Metrics outputs to workspace
connect_metric_outputs(model_name, pid_metrics, 'pid');
connect_metric_outputs(model_name, lstm_metrics, 'lstm');

save_system(model_name, model_path);
close_system(model_name);

end

function block = create_block(model, name, library, position, params)
block = [model '/' name];
add_block(library, block, 'MakeNameUnique', 'off');
set_param(block, 'Position', position);
if nargin >= 5 && ~isempty(params)
    param_names = fieldnames(params);
    for k = 1:numel(param_names)
        set_param(block, param_names{k}, convert_to_string(params.(param_names{k})));
    end
end
end

function str = convert_to_string(value)
if ischar(value)
    str = value;
elseif isnumeric(value)
    str = num2str(value, '%.12g');
else
    str = char(string(value));
end
end

function sample_time = resolve_sample_time(value, Ts)
if ischar(value) && strcmp(value, 'Ts')
    sample_time = num2str(Ts, '%.12g');
elseif isnumeric(value)
    sample_time = num2str(value, '%.12g');
else
    sample_time = convert_to_string(value);
end
end

function block = add_pid_block(model, pid_cfg, Ts, position)
block = create_block(model, 'pid_controller', 'simulink/Discrete/PID Controller', position, struct());
sample_time = resolve_sample_time(pid_cfg.sample_time, Ts);
set_param(block, ...
    'Form', pid_cfg.form, ...
    'P', num2str(pid_cfg.p, '%.12g'), ...
    'I', num2str(pid_cfg.i, '%.12g'), ...
    'D', num2str(pid_cfg.d, '%.12g'), ...
    'N', num2str(pid_cfg.n, '%.12g'), ...
    'SampleTime', sample_time, ...
    'InitialConditionForIntegrator', num2str(pid_cfg.initial_integrator, '%.12g'), ...
    'InitialConditionForFilter', num2str(pid_cfg.initial_filter, '%.12g'), ...
    'AntiWindupMethod', pid_cfg.anti_windup, ...
    'UpperSaturationLimit', num2str(pid_cfg.upper_saturation, '%.12g'), ...
    'LowerSaturationLimit', num2str(pid_cfg.lower_saturation, '%.12g'));
end

function block = add_discrete_plant(model, plant_cfg, Ts, position)
block = create_block(model, 'plant', 'simulink/Discrete/Transfer Fcn', position, struct());
continuous_tf = tf(plant_cfg.gain, [plant_cfg.time_constant 1]);
discrete_tf = c2d(continuous_tf, Ts, 'zoh');
[num, den] = tfdata(discrete_tf, 'v');
set_param(block, ...
    'Numerator', mat2str(num, 12), ...
    'Denominator', mat2str(den, 12), ...
    'SampleTime', num2str(Ts, '%.12g'));
end

function block = add_to_workspace(model, name, variable, position)
block = create_block(model, name, 'simulink/Sinks/To Workspace', position, struct( ...
    'VariableName', variable, ...
    'SaveFormat', 'Structure With Time', ...
    'MaxDataPoints', 'inf'));
end

function subsystem = create_metrics_subsystem(model, name, Ts, position)
subsystem = create_block(model, name, 'simulink/Ports & Subsystems/Subsystem', position, struct());
Simulink.BlockDiagram.deleteContents(subsystem);
add_block('simulink/Ports & Subsystems/In1', [subsystem '/In1'], 'Position', [30 60 60 90]);
add_block('simulink/Ports & Subsystems/Out1', [subsystem '/iae'], 'Position', [430 30 460 60]);
add_block('simulink/Ports & Subsystems/Out1', [subsystem '/ise'], 'Position', [430 90 460 120]);
add_block('simulink/Ports & Subsystems/Out1', [subsystem '/itae'], 'Position', [430 150 460 180]);

abs_block = add_inner_block(subsystem, 'abs', 'simulink/Math Operations/Abs', [100 50 140 90]);
vector_sum = add_inner_block(subsystem, 'vector_sum', 'simulink/Math Operations/Sum', [170 40 220 90], struct('Inputs', '+'));
set_param(vector_sum, 'CollapseMode', 'All dimensions');
clock_block = add_inner_block(subsystem, 'clock', 'simulink/Sources/Clock', [100 150 140 190]);
square = add_inner_block(subsystem, 'square', 'simulink/Math Operations/Product', [170 100 220 140], struct('Inputs', '**'));
itae_product = add_inner_block(subsystem, 'itae_product', 'simulink/Math Operations/Product', [170 160 220 200], struct('Inputs', '**'));

iae_gain = add_inner_block(subsystem, 'iae_gain', 'simulink/Math Operations/Gain', [250 40 300 90], struct('Gain', num2str(Ts, '%.12g')));
ise_gain = add_inner_block(subsystem, 'ise_gain', 'simulink/Math Operations/Gain', [250 100 300 150], struct('Gain', num2str(Ts, '%.12g')));
itae_gain = add_inner_block(subsystem, 'itae_gain', 'simulink/Math Operations/Gain', [250 160 300 210], struct('Gain', num2str(Ts, '%.12g')));

iae_int = add_inner_block(subsystem, 'iae_int', 'simulink/Discrete/Discrete-Time Integrator', [320 40 370 90], struct('SampleTime', num2str(Ts, '%.12g')));
ise_int = add_inner_block(subsystem, 'ise_int', 'simulink/Discrete/Discrete-Time Integrator', [320 100 370 150], struct('SampleTime', num2str(Ts, '%.12g')));
itae_int = add_inner_block(subsystem, 'itae_int', 'simulink/Discrete/Discrete-Time Integrator', [320 160 370 210], struct('SampleTime', num2str(Ts, '%.12g')));

add_line(subsystem, 'In1/1', 'abs/1', 'autorouting', 'on');
add_line(subsystem, 'abs/1', 'vector_sum/1', 'autorouting', 'on');
add_line(subsystem, 'vector_sum/1', 'iae_gain/1', 'autorouting', 'on');
add_line(subsystem, 'iae_gain/1', 'iae_int/1', 'autorouting', 'on');
add_line(subsystem, 'iae_int/1', 'iae/1', 'autorouting', 'on');

add_line(subsystem, 'In1/1', 'square/1', 'autorouting', 'on');
add_line(subsystem, 'In1/1', 'square/2', 'autorouting', 'on');
add_line(subsystem, 'square/1', 'ise_gain/1', 'autorouting', 'on');
add_line(subsystem, 'ise_gain/1', 'ise_int/1', 'autorouting', 'on');
add_line(subsystem, 'ise_int/1', 'ise/1', 'autorouting', 'on');

add_line(subsystem, 'abs/1', 'itae_product/1', 'autorouting', 'on');
add_line(subsystem, 'clock/1', 'itae_product/2', 'autorouting', 'on');
add_line(subsystem, 'itae_product/1', 'itae_gain/1', 'autorouting', 'on');
add_line(subsystem, 'itae_gain/1', 'itae_int/1', 'autorouting', 'on');
add_line(subsystem, 'itae_int/1', 'itae/1', 'autorouting', 'on');

close_system(subsystem);
end

function block = add_inner_block(parent, name, library, position, params)
if nargin < 5
    params = struct();
end
block = [parent '/' name];
add_block(library, block, 'MakeNameUnique', 'off', 'Position', position);
param_names = fieldnames(params);
for k = 1:numel(param_names)
    set_param(block, param_names{k}, convert_to_string(params.(param_names{k})));
end
end

function connect_metric_outputs(model, subsystem, prefix)
if strcmp(prefix, 'pid')
    row = 0;
else
    row = 1;
end
base_y = 120 + 180 * row;
iae_sink = add_to_workspace(model, [prefix '_iae_sink'], ['iae_' prefix], [1040 base_y 1150 base_y + 50]);
ise_sink = add_to_workspace(model, [prefix '_ise_sink'], ['ise_' prefix], [1040 base_y + 60 1150 base_y + 110]);
itae_sink = add_to_workspace(model, [prefix '_itae_sink'], ['itae_' prefix], [1040 base_y + 120 1150 base_y + 170]);
block_name = get_param(subsystem, 'Name');
add_line(model, [block_name '/1'], [iae_sink '/1'], 'autorouting', 'on');
add_line(model, [block_name '/2'], [ise_sink '/1'], 'autorouting', 'on');
add_line(model, [block_name '/3'], [itae_sink '/1'], 'autorouting', 'on');
end

function script = build_k_of_n_script(cfg)
script = sprintf([ ...
    'function flag = k_of_n_latch(checks)\n' ...
    '%%#codegen\n' ...
    'persistent count;\n' ...
    'persistent latched;\n' ...
    'if isempty(count)\n    count = 0;\nend\n' ...
    'if isempty(latched)\n    latched = false;\nend\n' ...
    'if any(checks(:))\n    count = min(%d, count + 1);\nelse\n    count = max(0, count - 1);\nend\n' ...
    'if count >= %d\n    latched = true;\nelseif count <= %d\n    latched = false;\nend\n' ...
    'flag = latched;\n' ...
    'end'], cfg.n, cfg.k, cfg.release);
end
