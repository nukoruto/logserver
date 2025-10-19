function save_structure_with_time(variable, output_path)
%SAVE_STRUCTURE_WITH_TIME Persist a Simulink Structure with Time variable.
%   SAVE_STRUCTURE_WITH_TIME(VARIABLE, OUTPUT_PATH) saves the supplied
%   STRUCT array into OUTPUT_PATH using MATLAB's MAT-file format. The
%   function validates that the required fields "time" and "signals" are
%   present and that the payload is compatible with Simulink's Structure
%   with Time specification.
%
%   Example:
%       save_structure_with_time(ref_sig, 'ref_sig.mat');
%
%   This helper keeps all scripts consistent with the same validation
%   scheme so that round-tripping the saved data results in isequaln
%   structures.
arguments
    variable (1, 1) struct
    output_path (1, :) char
end

validate_structure_with_time(variable);
output_dir = fileparts(output_path);
if ~isempty(output_dir) && ~exist(output_dir, 'dir') %#ok<EXIST>
    mkdir(output_dir);
end
save(output_path, '-struct', 'variable', '-v7');

end

function validate_structure_with_time(payload)
if ~isfield(payload, 'time') || ~isfield(payload, 'signals')
    error('save_structure_with_time:InvalidStructure', ...
        'Structure with Time must include time and signals fields.');
end
if ~isnumeric(payload.time)
    error('save_structure_with_time:InvalidTime', ...
        'Time vector must be numeric.');
end
signals = payload.signals;
if ~isstruct(signals) || ~isfield(signals, 'values') || ~isfield(signals, 'dimensions')
    error('save_structure_with_time:InvalidSignals', ...
        ['signals field must be a struct containing values and dimensions ', ...
         'fields.']);
end
if ~isnumeric(signals.values)
    error('save_structure_with_time:InvalidValues', ...
        'signals.values must be numeric.');
end
if ~isnumeric(signals.dimensions) || ~isscalar(signals.dimensions)
    error('save_structure_with_time:InvalidDimensions', ...
        'signals.dimensions must be a numeric scalar.');
end
if size(signals.values, 2) ~= signals.dimensions && ...
        ~(signals.dimensions == 1 && isvector(signals.values))
    error('save_structure_with_time:DimensionMismatch', ...
        'signals.values width must equal signals.dimensions.');
end

end
