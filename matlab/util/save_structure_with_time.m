%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

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
