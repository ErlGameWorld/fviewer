%%%-------------------------------------------------------------------
%% @doc fviewer application callback
%% @end
%%%-------------------------------------------------------------------
-module(fviewer_app).

-behaviour(application).

-export([start/2, stop/1]).

start(_StartType, _StartArgs) ->
    {ok, Pid} = fviewer_sup:start_link(),
    Port = application:get_env(fviewer, port, 8989),
    case fviewer:open(Port) of
        {ok, _} ->
            fviewer:start_idle_timer(),
            {ok, Pid};
        {error, Reason} ->
            exit(Pid, shutdown),
            {error, Reason}
    end.

stop(_State) ->
    fviewer:close(),
    ok.
