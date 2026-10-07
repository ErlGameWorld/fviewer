%% Public API + escript entry for fviewer.
-module(fviewer).

-export([
    main/1
    , start/0
    , start/1
    , start/2
    , stop/0
    , stop/1
    , open/1
    , open/2
    , close/0
    , close/1
    , shutdown_idle/0
    , start_idle_timer/0
    , bump_activity/0
    , idle_check/0
    , start_external/1
    , start_external/2
    , stop_external/1
]).

-define(DEFAULT_PORT, 8989).
-define(DEFAULT_IDLE_SEC, 1800).
-define(APP, fviewer).
-define(HANDLE_TIME, handle_time).
-define(IDLE_TIMEOUT, idle_timeout).
-define(IDLE_TICK_MS, 60_000).

%% ========== escript ==========
%% Usage:
%%   fviewer [--port N] [--dir PATH] [--idle-timeout SECS]
%%   fviewer [PORT]
%%
%% --idle-timeout  idle seconds without HTTP/WS activity before exit (default 1800 = 30min).
%%                 0 = never auto-stop.
main(Args) ->
    {Port, Dir, IdleSec} = parse_args(Args, ?DEFAULT_PORT, undefined, undefined),
    maybe_cd(Dir),
    case start(Port, IdleSec) of
        {ok, _} ->
            {ok, Cwd} = file:get_cwd(),
            io:format("fviewer listening on http://0.0.0.0:~p/~n", [Port]),
            io:format("root directory: ~ts~n", [Cwd]),
            io:format("websocket: ws://0.0.0.0:~p/ws~n", [Port]),
            print_idle_timeout(),
            receive after infinity -> ok end;
        {error, {already_started, _}} ->
            io:format("fviewer already running on this node~n"),
            erlang:halt(0);
        {error, Reason} ->
            io:format("failed to start fviewer: ~p~n", [Reason]),
            erlang:halt(1)
    end.

%% ========== OTP helpers ==========
start() ->
    start(?DEFAULT_PORT).

start(Port) when is_integer(Port) ->
    start(Port, undefined).

start(Port, IdleSec) when is_integer(Port) ->
    application:load(?APP),
    application:set_env(?APP, port, Port),
    set_idle_timeout(IdleSec),
    application:ensure_all_started(?APP).

set_idle_timeout(undefined) ->
    persistent_term:put(?IDLE_TIMEOUT, ?DEFAULT_IDLE_SEC);
set_idle_timeout(Sec) when is_integer(Sec), Sec >= 0 ->
    persistent_term:put(?IDLE_TIMEOUT, Sec).

idle_timeout() ->
    persistent_term:get(?IDLE_TIMEOUT, ?DEFAULT_IDLE_SEC).

shutdown_idle() ->
    io:format(standard_error, "fviewer: idle timeout, shutting down~n", []),
    try stop() catch _:_ -> ok end,
    init:stop().

start_idle_timer() ->
    case idle_timeout() of
        0 -> ok;
        _ ->
            persistent_term:put(?HANDLE_TIME, erlang:monotonic_time(second)),
            timer:apply_after(?IDLE_TICK_MS, ?MODULE, idle_check, [])
    end.

bump_activity() ->
    case idle_timeout() of
        0 -> ok;
        _ -> persistent_term:put(?HANDLE_TIME, erlang:monotonic_time(second))
    end.

idle_check() ->
    Sec = idle_timeout(),
    Last = persistent_term:get(?HANDLE_TIME),
    Now = erlang:monotonic_time(second),
    case Now - Last >= Sec of
        true ->
            shutdown_idle();
        false ->
            timer:apply_after(?IDLE_TICK_MS, ?MODULE, idle_check, [])
    end.

stop() ->
    application:stop(?APP).

stop(Port) when is_integer(Port) ->
    close(Port),
    stop().

open(Port) ->
    open(Port, []).

open(Port, ExtraOpts) when is_integer(Port) ->
    TcpOpts0 = proplists:get_value(tcpOpts, ExtraOpts, []),
    TcpOpts = lists:keystore(ip, 1, TcpOpts0, {ip, {0, 0, 0, 0}}),
    Opts0 = lists:keystore(tcpOpts, 1, ExtraOpts, {tcpOpts, TcpOpts}),
    Opts = [
        {wsMod, fviewer_her},
        %% Allow large file payloads (base64 of up to 32MB ≈ 43MB).
        {maxSize, 64 * 1024 * 1024}
        | Opts0
    ],
    try eWSrv:openSrv(Port, Opts) of
        {ok, _} = Ok ->
            Ok;
        Other ->
            Other
    catch
        error:{badmatch, {error, {already_started, Pid}}} ->
            {ok, Pid};
        error:{badmatch, {error, Reason}} ->
            {error, Reason};
        error:{badmatch, Reason} ->
            {error, Reason}
    end.

close() ->
    case application:get_env(?APP, port) of
        {ok, Port} -> close(Port);
        undefined -> ok
    end.

close(Port) when is_integer(Port) ->
    try eWSrv:closeSrv(Port) of
        _ -> ok
    catch
        _:_ -> ok
    end.

%% Start the packaged escript from another Erlang node.
%% Returns {ok, PortRef} where PortRef is an Erlang port — NOT the HTTP listen port.
%% Stop with fviewer:stop_external(PortRef) (calls erlang:port_close/1).
-spec start_external(pos_integer()) -> {ok, port()} | {error, term()}.
start_external(ListenPort) ->
    start_external(ListenPort, #{}).

-spec start_external(pos_integer(), map()) -> {ok, port()} | {error, term()}.
start_external(ListenPort, Opts) when is_integer(ListenPort), is_map(Opts) ->
    Escript = maps:get(escript, Opts, default_escript()),
    Dir = maps:get(dir, Opts, undefined),
    IdleSec = maps:get(idle_timeout, Opts, undefined),
    Args0 = [integer_to_list(ListenPort)],
    Args1 = append_arg(Args0, "--dir", dir_arg(Dir)),
    Args = append_arg(Args1, "--idle-timeout", idle_arg(IdleSec)),

    case filelib:is_file(Escript) of
        false ->
            {error, {escript_not_found, Escript}};
        true ->
            PortRef = open_port(
                {spawn_executable, Escript},
                [
                    {args, Args},
                    {cd, case Dir of undefined -> "."; D2 -> D2 end},
                    binary,
                    exit_status,
                    stderr_to_stdout
                ]
            ),
            {ok, PortRef}
    end.

-spec stop_external(port()) -> ok.
stop_external(PortRef) when is_port(PortRef) ->
    case erlang:port_info(PortRef) of
        undefined -> ok;
        _ -> erlang:port_close(PortRef)
    end,
    ok.

dir_arg(undefined) -> undefined;
dir_arg(Dir) when is_list(Dir) -> Dir;
dir_arg(Dir) when is_binary(Dir) -> unicode:characters_to_list(Dir).

idle_arg(undefined) -> undefined;
idle_arg(Sec) when is_integer(Sec), Sec >= 0 -> integer_to_list(Sec).

append_arg(Args, _Flag, undefined) ->
    Args;
append_arg(Args, Flag, Value) ->
    Args ++ [Flag, Value].

default_escript() ->
    case os:getenv("FVIEWER_ESCRIPT") of
        false ->
            filename:join(["_build", "default", "bin", "fviewer"]);
        Path ->
            Path
    end.

%% ========== arg parsing ==========
parse_args([], Port, Dir, Idle) ->
    {Port, Dir, Idle};
parse_args(["--port", PortStr | Rest], _Port, Dir, Idle) ->
    parse_args(Rest, parse_port(PortStr), Dir, Idle);
parse_args(["--dir", Dir | Rest], Port, _Dir, Idle) ->
    parse_args(Rest, Port, Dir, Idle);
parse_args(["--idle-timeout", SecStr | Rest], Port, Dir, _Idle) ->
    parse_args(Rest, Port, Dir, parse_idle_timeout(SecStr));
parse_args([[$- | _] = Flag | _], _Port, _Dir, _Idle) ->
    io:format("unknown flag: ~s~n", [Flag]),
    usage(),
    erlang:halt(2);
parse_args([PortStr | Rest], _Port, Dir, Idle) ->
    parse_args(Rest, parse_port(PortStr), Dir, Idle).

parse_port(PortStr) ->
    case string:to_integer(PortStr) of
        {error, _} ->
            usage(),
            erlang:halt(2);
        {Port, ""} when Port >= 1, Port =< 65535 ->
            Port;
        _ ->
            usage(),
            erlang:halt(2)
    end.

parse_idle_timeout(SecStr) ->
    case string:to_integer(SecStr) of
        {error, _} ->
            usage(),
            erlang:halt(2);
        {Sec, ""} when Sec >= 0 ->
            Sec;
        _ ->
            usage(),
            erlang:halt(2)
    end.

print_idle_timeout() ->
    case idle_timeout() of
        0 ->
            io:format("idle timeout: disabled~n");
        Sec ->
            io:format("idle timeout: ~p s (~p min, no HTTP/WS activity)~n", [Sec, Sec div 60])
    end.

maybe_cd(undefined) -> ok;
maybe_cd(Dir) ->
    case file:set_cwd(Dir) of
        ok -> ok;
        {error, Reason} ->
            io:format("cannot cd to ~ts: ~p~n", [Dir, Reason]),
            erlang:halt(1)
    end.

usage() ->
    io:format(
        "Usage:~n"
        "  fviewer [--port N] [--dir PATH] [--idle-timeout SECS]~n"
        "  fviewer [PORT]~n"
        "~n"
        "  --port           listen port (default ~p)~n"
        "  --dir            root directory to browse~n"
        "  --idle-timeout   auto-exit after SECS without HTTP/WebSocket"
        "                   activity (default ~p = 30 min); 0 = never~n",
        [?DEFAULT_PORT, ?DEFAULT_IDLE_SEC]
    ).
