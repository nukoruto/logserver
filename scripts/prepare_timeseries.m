function prepare_timeseries(config_path)
%PREPARE_TIMESERIES Convert CSV logs into Structure with Time MAT files.
%   PREPARE_TIMESERIES(CONFIG_PATH) reads the configuration JSON (default
%   config/sim_config.json), loads the reference and LSTM output CSV files,
%   orders them by timestamp, converts them into one-hot/probability
%   vectors, and saves the resulting structures as MAT files compatible
%   with Simulink's From Workspace block.
arguments
    config_path (1, :) char = 'config/sim_config.json'
end

cfg = jsondecode(fileread(config_path));
base_dir = fileparts(mfilename('fullpath'));
addpath(base_dir);

category_count = cfg.category_count;
vocab = jsondecode(fileread(cfg.data.vocab_json));
stoi = vocab.stoi;
labels = resolve_labels(stoi, category_count);

ref_table = readtable(cfg.data.ref_csv, TextType="string");
ref_table = sortrows(ref_table, "timestamp_utc", "ascend");
ref_time = posixtime(datetime(ref_table.timestamp_utc, TimeZone="UTC"));
ref_values = encode_categories(ref_table.op_category, stoi, category_count);
ref_sig = build_structure(ref_time, ref_values, labels, "ref");

lstm_table = readtable(cfg.data.lstm_csv, TextType="string");
lstm_table = sortrows(lstm_table, "timestamp_utc", "ascend");
lstm_time = posixtime(datetime(lstm_table.timestamp_utc, TimeZone="UTC"));
lstm_values = resolve_lstm_values(lstm_table, stoi, category_count, cfg.lstm_output_mode);
y_lstm_sig = build_structure(lstm_time, lstm_values, labels, "y_lstm");

output_dir = cfg.data.output_dir;
if ~exist(output_dir, "dir") %#ok<EXIST>
    mkdir(output_dir);
end

save_structure_with_time(ref_sig, fullfile(output_dir, "ref_sig.mat"));
save_structure_with_time(y_lstm_sig, fullfile(output_dir, "y_lstm_sig.mat"));

end

function labels = resolve_labels(stoi, category_count)
fields = fieldnames(stoi);
indices = struct2cell(stoi);
indices = cellfun(@double, indices);
labels = strings(category_count, 1);
for i = 1:numel(fields)
    index = indices(i) + 1;
    if index <= category_count
        labels(index) = string(fields{i});
    end
end
end

function values = encode_categories(categories, stoi, category_count)
n = numel(categories);
values = zeros(n, category_count, "double");
for i = 1:n
    token = char(categories(i));
    if isfield(stoi, token)
        idx = double(stoi.(token)) + 1;
    else
        error("prepare_timeseries:UnknownCategory", ...
            "Category %s is not defined in the vocabulary.", token);
    end
    values(i, idx) = 1.0;
end
end

function structure = build_structure(time_vector, values, labels, base_name)
structure = struct();
structure.time = double(time_vector(:));
signals = struct();
signals.values = double(values);
signals.dimensions = size(values, 2);
signals.labels = labels(:)';
signals.title = base_name;
structure.signals = signals;
end

function values = resolve_lstm_values(table_data, stoi, category_count, mode)
switch lower(string(mode))
    case "probabilities"
        pattern = startsWith(table_data.Properties.VariableNames, "probs_");
        prob_columns = table_data.Properties.VariableNames(pattern);
        if numel(prob_columns) ~= category_count
            error("prepare_timeseries:InvalidProbabilityColumns", ...
                "Expected %d probability columns, found %d.", ...
                category_count, numel(prob_columns));
        end
        indices = zeros(numel(prob_columns), 1);
        for j = 1:numel(prob_columns)
            token = regexp(prob_columns{j}, '^probs_(\d+)$', 'tokens', 'once');
            if isempty(token)
                error("prepare_timeseries:InvalidProbabilityColumns", ...
                    "Column %s does not match probs_%%d naming.", prob_columns{j});
            end
            indices(j) = str2double(token{1});
        end
        [~, order] = sort(indices);
        prob_columns = prob_columns(order);
        values = zeros(height(table_data), category_count, "double");
        for i = 1:category_count
            values(:, i) = table_data.(prob_columns{i});
        end
    case "top1"
        values = encode_categories(table_data.pred_category, stoi, category_count);
    otherwise
        error("prepare_timeseries:UnsupportedMode", ...
            "Unsupported lstm_output_mode: %s", mode);
end
end
