%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

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
