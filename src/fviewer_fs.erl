%% Filesystem helpers for the file viewer.
-module(fviewer_fs).

-export([
    abs_path/1
    , list_dir/1
    , read_file/1
    , write_file/3
    , parent_path/1
    , path_info/1
    , list_roots/0
]).

-include_lib("kernel/include/file.hrl").

%% Keep a ceiling so huge files don't blow up memory / WebSocket JSON.
%% Intranet-friendly default: 300MB.
-define(MAX_FILE_BYTES, 300 * 1024 * 1024).

-define(BINARY_EXTS, [
    ".xlsx", ".xls", ".xlsm", ".xlsb",
    ".docx", ".doc",
    ".pdf",
    ".odt",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"
]).

-spec abs_path(binary() | string()) -> string().
abs_path(Path) when is_binary(Path) ->
    abs_path(unicode:characters_to_list(Path));
abs_path(Path) when is_list(Path) ->
    case filename:pathtype(Path) of
        absolute -> filename:nativename(Path);
        _ ->
            {ok, Cwd} = file:get_cwd(),
            filename:nativename(filename:absname(Path, Cwd))
    end.

%% Windows: existing drive letters. Unix: "/".
-spec list_roots() -> [binary()].
list_roots() ->
    case os:type() of
        {win32, _} ->
            lists:filtermap(
                fun(Letter) ->
                    Root = [Letter, $:, $\\],
                    case file:read_file_info(Root) of
                        {ok, _} -> {true, unicode:characters_to_binary(Root)};
                        _ -> false
                    end
                end,
                lists:seq($A, $Z)
            );
        _ ->
            [<<"/">>]
    end.

-spec parent_path(binary() | string()) -> string().
parent_path(Path) ->
    Abs = abs_path(Path),
    case filename:dirname(Abs) of
        Abs -> Abs;
        Parent -> Parent
    end.

-spec list_dir(binary() | string()) -> {ok, map()} | {error, term()}.
list_dir(Path0) ->
    Path = abs_path(Path0),
    case file:list_dir(Path) of
        {ok, Names} ->
            Entries = lists:filtermap(fun(Name) ->
                Full = filename:join(Path, Name),
                case file:read_file_info(Full, [{time, posix}]) of
                    {ok, #file_info{type = directory, mtime = MTime, mode = Mode}} ->
                        {true, entry_map(Name, <<"dir">>, 0, MTime, Mode)};
                    {ok, #file_info{type = regular, size = Size, mtime = MTime, mode = Mode}} ->
                        {true, entry_map(Name, <<"file">>, Size, MTime, Mode)};
                    _ ->
                        false
                end
            end, Names),
            Sorted = lists:sort(fun(A, B) ->
                TA = maps:get(<<"type">>, A),
                TB = maps:get(<<"type">>, B),
                case {TA, TB} of
                    {<<"dir">>, <<"file">>} -> true;
                    {<<"file">>, <<"dir">>} -> false;
                    _ -> maps:get(<<"name">>, A) =< maps:get(<<"name">>, B)
                end
            end, Entries),
            {ok, #{
                <<"path">> => unicode:characters_to_binary(Path),
                <<"parent">> => unicode:characters_to_binary(parent_path(Path)),
                <<"entries">> => Sorted
            }};
        {error, Reason} ->
            {error, Reason}
    end.

-spec read_file(binary() | string()) -> {ok, map()} | {error, term()}.
read_file(Path0) ->
    Path = abs_path(Path0),
    case file:read_file_info(Path) of
        {ok, #file_info{type = regular, size = Size}} when Size > ?MAX_FILE_BYTES ->
            {error, {too_large, Size, ?MAX_FILE_BYTES}};
        {ok, #file_info{type = regular, size = Size}} ->
            case file:read_file(Path) of
                {ok, Bin} when byte_size(Bin) > ?MAX_FILE_BYTES ->
                    {error, {too_large, byte_size(Bin), ?MAX_FILE_BYTES}};
                {ok, Bin} ->
                    {Content, Encoding} = decode_content(Path, Bin),
                    {ok, #{
                        <<"path">> => unicode:characters_to_binary(Path),
                        <<"size">> => Size,
                        <<"encoding">> => Encoding,
                        <<"content">> => Content
                    }};
                {error, Reason} ->
                    {error, Reason}
            end;
        {ok, #file_info{type = Type}} ->
            {error, {not_regular, Type}};
        {error, Reason} ->
            {error, Reason}
    end.

-spec write_file(binary() | string(), binary(), binary() | string()) ->
    {ok, map()} | {error, term()}.
write_file(Path0, Encoding, Content0) ->
    Path = abs_path(Path0),
    case decode_write_content(Encoding, Content0) of
        {error, Reason} ->
            {error, Reason};
        {ok, Bin} when byte_size(Bin) > ?MAX_FILE_BYTES ->
            {error, {too_large, byte_size(Bin), ?MAX_FILE_BYTES}};
        {ok, Bin} ->
            Dir = filename:dirname(Path),
            case filelib:is_dir(Dir) of
                false ->
                    {error, {no_such_dir, Dir}};
                true ->
                    case file:write_file(Path, Bin) of
                        ok ->
                            {ok, #{
                                <<"path">> => unicode:characters_to_binary(Path),
                                <<"size">> => byte_size(Bin)
                            }};
                        {error, Reason} ->
                            {error, Reason}
                    end
            end
    end.

decode_write_content(Encoding, Content) when is_list(Content) ->
    decode_write_content(Encoding, unicode:characters_to_binary(Content));
decode_write_content(<<"base64">>, Content) when is_binary(Content) ->
    try {ok, base64:decode(Content)} catch _:_ -> {error, bad_base64} end;
decode_write_content(Enc, Content) when Enc =:= <<"utf8">>; Enc =:= <<"latin1">> ->
    {ok, Content};
decode_write_content(Enc, _Content) ->
    {error, {bad_encoding, Enc}}.

-spec path_info(binary() | string()) -> {ok, map()} | {error, term()}.
path_info(Path0) ->
    Path = abs_path(Path0),
    case file:read_file_info(Path, [{time, posix}]) of
        {ok, #file_info{type = Type, size = Size, mtime = MTime}} ->
            TypeBin = case Type of
                          directory -> <<"dir">>;
                          regular -> <<"file">>;
                          _ -> atom_to_binary(Type, utf8)
                      end,
            {ok, #{
                <<"path">> => unicode:characters_to_binary(Path),
                <<"parent">> => unicode:characters_to_binary(parent_path(Path)),
                <<"type">> => TypeBin,
                <<"size">> => Size,
                <<"mtime">> => MTime
            }};
        {error, Reason} ->
            {error, Reason}
    end.

mtime_unix(MTime) when is_integer(MTime) ->
    MTime;
mtime_unix({Date, Time}) ->
    {UDate, UTime, _} = calendar:local_time_to_universal_time_dst({Date, Time}),
    calendar:datetime_to_gregorian_seconds({UDate, UTime}) -
        calendar:datetime_to_gregorian_seconds({{1970, 1, 1}, {0, 0, 0}}).

entry_map(Name, Type, Size, MTime, _Mode) ->
    #{
        <<"name">> => unicode:characters_to_binary(Name),
        <<"type">> => Type,
        <<"size">> => Size,
        <<"mtime">> => mtime_unix(MTime),
        <<"hidden">> => is_dot_name(Name)
    }.

is_dot_name(Name) when is_list(Name) ->
    case Name of
        [$. | _] -> true;
        _ -> false
    end;
is_dot_name(Name) when is_binary(Name) ->
    case Name of
        <<".", _/binary>> -> true;
        _ -> false
    end.

ext_lower(Path) ->
    string:lowercase(filename:extension(Path)).

is_binary_file(Path) ->
    lists:member(ext_lower(Path), ?BINARY_EXTS).

decode_content(Path, Bin) ->
    case is_binary_file(Path) of
        true ->
            {base64:encode(Bin), <<"base64">>};
        false ->
            case unicode:characters_to_binary(Bin, utf8, utf8) of
                Out when is_binary(Out) ->
                    {Out, <<"utf8">>};
                {error, _, _} ->
                    {unicode:characters_to_binary(Bin, latin1, utf8), <<"latin1">>};
                {incomplete, _, _} ->
                    {unicode:characters_to_binary(Bin, latin1, utf8), <<"latin1">>}
            end
    end.
