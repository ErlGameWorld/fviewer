%% eWSrv request / websocket handler for fviewer.
-module(fviewer_her).

-include_lib("eWSrv/include/wsCom.hrl").

-export([
    init/1
    , handle/3
    , handleWs/3
    , supportedProtocols/0
    , supportedExtensions/0
]).

-record(st, {
    cwd :: string()
}).

init(_Args) ->
    {ok, Cwd} = file:get_cwd(),
    {ok, #st{cwd = Cwd}}.

handle(Method, Path, WsReq) ->
    fviewer:bump_activity(),
    do_handle(Method, Path, WsReq).

do_handle('GET', <<"/">>, _WsReq) ->
    %% The whole UI is one inlined HTML file: never let a browser keep an old copy,
    %% otherwise a restarted server still shows the previous frontend build.
    {ok,
        [
            {<<"Content-Type">>, webshow:content_type()},
            {<<"Cache-Control">>, <<"no-store, no-cache, must-revalidate">>},
            {<<"Pragma">>, <<"no-cache">>}
        ],
        webshow:index_html()};

do_handle('GET', <<"/index.html">>, WsReq) ->
    do_handle('GET', <<"/">>, WsReq);

do_handle('GET', <<"/ws">>, WsReq) ->
    case wsWebSocket:tryWsUpgrade(WsReq) of
        {ok, Headers} ->
            {wsUpgrade, Headers};
        {error, Reason} ->
            {502, [{<<"Content-Type">>, <<"text/plain">>}], Reason}
    end;

do_handle('GET', <<"/health">>, _WsReq) ->
    {ok, [{<<"Content-Type">>, <<"application/json">>}], <<"{\"ok\":true}">>};

do_handle(_Method, _Path, _WsReq) ->
    {404, [{<<"Content-Type">>, <<"text/plain">>}], <<"Not Found">>}.

handleWs(OpCode, Payload, State) ->
    fviewer:bump_activity(),
    do_ws(OpCode, Payload, ensure_state(State)).

ensure_state(#st{} = St) ->
    St;
ensure_state(_) ->
    {ok, Cwd} = file:get_cwd(),
    #st{cwd = Cwd}.

do_ws(?WsOpText, Message, State) ->
    try json:decode(Message) of
        Map when is_map(Map) ->
            Reply = dispatch(Map, State),
            {ok, ?WsOpText, iolist_to_binary(json:encode(Reply)), State};
        _Other ->
            Err = #{
                <<"op">> => <<"error">>,
                <<"message">> => <<"expected json object">>
            },
            {ok, ?WsOpText, iolist_to_binary(json:encode(Err)), State}
    catch
        error:Reason ->
            Err = #{
                <<"op">> => <<"error">>,
                <<"message">> => iolist_to_binary(io_lib:format("bad json: ~p", [Reason]))
            },
            {ok, ?WsOpText, iolist_to_binary(json:encode(Err)), State}
    end;

do_ws(?WsOpBinary, _Data, State) ->
    {ok, State};

do_ws(?WsOpClose, _Data, State) ->
    {close, State};

do_ws(?WsOpPing, Data, State) ->
    {ok, ?WsOpPong, Data, State};

do_ws(?WsOpPong, _Data, State) ->
    {ok, State};

do_ws(_OpCode, _Data, State) ->
    {ok, State}.

dispatch(#{<<"op">> := <<"hello">>}, #st{cwd = Cwd}) ->
    #{
        <<"op">> => <<"hello">>,
        <<"cwd">> => unicode:characters_to_binary(Cwd),
        <<"node">> => atom_to_binary(node(), utf8),
        <<"roots">> => fviewer_fs:list_roots()
    };

dispatch(#{<<"op">> := <<"roots">>}, _State) ->
    #{<<"op">> => <<"roots">>, <<"roots">> => fviewer_fs:list_roots()};

dispatch(#{<<"op">> := <<"list">>, <<"path">> := Path} = Msg, _State) ->
    case fviewer_fs:list_dir(Path) of
        {ok, Info} -> list_reply(Info, Msg);
        {error, Reason} -> err(Reason)
    end;

dispatch(#{<<"op">> := <<"list">>} = Msg, #st{cwd = Cwd}) ->
    case fviewer_fs:list_dir(Cwd) of
        {ok, Info} -> list_reply(Info, Msg);
        {error, Reason} -> err(Reason)
    end;

dispatch(#{<<"op">> := <<"read">>, <<"path">> := Path}, _State) ->
    case fviewer_fs:read_file(Path) of
        {ok, Info} -> Info#{<<"op">> => <<"file">>};
        {error, Reason} -> err(Reason)
    end;

dispatch(#{<<"op">> := <<"write">>, <<"path">> := Path} = Msg, _State) ->
    Encoding = maps:get(<<"encoding">>, Msg, <<"base64">>),
    Content = maps:get(<<"content">>, Msg, <<>>),
    case fviewer_fs:write_file(Path, Encoding, Content) of
        {ok, Info} -> Info#{<<"op">> => <<"written">>};
        {error, Reason} -> err(Reason)
    end;

dispatch(#{<<"op">> := <<"parent">>, <<"path">> := Path}, _State) ->
    Parent = fviewer_fs:parent_path(Path),
    case fviewer_fs:list_dir(Parent) of
        {ok, Info} -> Info#{<<"op">> => <<"list">>};
        {error, Reason} -> err(Reason)
    end;

dispatch(#{<<"op">> := <<"stat">>, <<"path">> := Path}, _State) ->
    case fviewer_fs:path_info(Path) of
        {ok, Info} -> Info#{<<"op">> => <<"stat">>};
        {error, Reason} -> err(Reason)
    end;

dispatch(_Msg, _State) ->
    #{<<"op">> => <<"error">>, <<"message">> => <<"unknown op">>}.

err(Reason) ->
    #{
        <<"op">> => <<"error">>,
        <<"message">> => iolist_to_binary(io_lib:format("~p", [Reason]))
    }.

list_reply(Info, Msg) ->
    case maps:get(<<"id">>, Msg, undefined) of
        undefined -> Info#{<<"op">> => <<"list">>};
        Id -> Info#{<<"op">> => <<"list">>, <<"id">> => Id}
    end.

supportedProtocols() -> [].
supportedExtensions() -> [].
