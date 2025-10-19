%% Auto-generated scaffold. See SRS.md and CONSTRAINTS.md.

function fn = choose_info_fn(method)
%CHOOSE_INFO_FN Select an information function handle based on method name.
%
%   FN = CHOOSE_INFO_FN(METHOD) returns a function handle that computes the
%   requested metric between reference and response signals.

arguments
    method (1, 1) string {mustBeMember(method, ["rmse", "nrmse", "mae", "mape"])}
end

switch method
    case "rmse"
        fn = @(ref, resp) sqrt(mean((resp - ref).^2));
    case "nrmse"
        fn = @(ref, resp) sqrt(mean((resp - ref).^2)) / max(max(ref) - min(ref), eps);
    case "mae"
        fn = @(ref, resp) mean(abs(resp - ref));
    case "mape"
        fn = @(ref, resp) mean(abs((resp - ref) ./ max(ref, eps)));
    otherwise
        error('choose_info_fn:UnsupportedMethod', 'Unsupported method: %s', method);
end
end
