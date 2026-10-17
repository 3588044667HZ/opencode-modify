package opencode.semantic;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.StandardProtocolFamily;
import java.nio.channels.Channels;
import java.nio.channels.ClosedChannelException;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * JSON-RPC 2.0 over TCP 127.0.0.1（ephemeral port），NDJSON 帧（一行一个对象，UTF-8）。
 * 绑定成功后原子写入 locator（{v,port,token,pid}）；每连接的第一个请求必须是携带正确
 * token 的 hello，未认证连接调用其它方法一律 -32019 并在冲刷响应后关闭。
 * 专用 accept 线程 + 每连接一个读线程；写操作按连接加锁以支持服务端推送。
 */
final class JsonRpcServer {

  private static final int UNAUTHORIZED = -32019;

  interface Handler {
    JsonObject handle(Client client, String method, JsonObject params) throws RpcException;
  }

  static final class RpcException extends Exception {
    private final int code;
    private final JsonElement data;

    RpcException(int code, String message, JsonElement data) {
      super(message);
      this.code = code;
      this.data = data;
    }

    int code() {
      return code;
    }

    JsonElement data() {
      return data;
    }
  }

  static final class Client {
    private final SocketChannel channel;
    private final BufferedOutputStream out;
    private final String name;
    private final Object writeLock = new Object();
    private volatile boolean subscribed;
    private volatile boolean authenticated;
    private volatile boolean closed;

    private Client(SocketChannel channel, String name) {
      this.channel = channel;
      this.name = name;
      this.out = new BufferedOutputStream(Channels.newOutputStream(channel));
    }

    void subscribe() {
      subscribed = true;
    }

    boolean isSubscribed() {
      return subscribed;
    }

    void authenticate() {
      authenticated = true;
    }

    boolean isAuthenticated() {
      return authenticated;
    }

    void send(JsonObject message) {
      if (closed) return;
      byte[] bytes = message.toString().getBytes(StandardCharsets.UTF_8);
      synchronized (writeLock) {
        if (closed) return;
        try {
          out.write(bytes);
          out.write('\n');
          out.flush();
        } catch (IOException e) {
          close();
        }
      }
    }

    void close() {
      closed = true;
      try {
        channel.close();
      } catch (IOException ignored) {
        // 关闭失败无需处理
      }
    }
  }

  private final Path locatorPath;
  private final Handler handler;
  private final long idleMillis;
  private final Set<Client> clients = ConcurrentHashMap.newKeySet();
  private final AtomicInteger clientCounter = new AtomicInteger();
  private final AtomicLong lastActivity = new AtomicLong(System.currentTimeMillis());
  private final AtomicBoolean stopping = new AtomicBoolean();
  private final CountDownLatch stopped = new CountDownLatch(1);
  private volatile ServerSocketChannel serverChannel;
  private String token;

  JsonRpcServer(Path locatorPath, Handler handler, long idleMillis) {
    this.locatorPath = locatorPath;
    this.handler = handler;
    this.idleMillis = idleMillis;
  }

  void start() throws IOException {
    Path parent = locatorPath.toAbsolutePath().getParent();
    if (parent != null) Files.createDirectories(parent);

    // 显式绑定 IPv4 loopback（不用通配地址与 ::1），port 0 由系统分配
    serverChannel = ServerSocketChannel.open(StandardProtocolFamily.INET);
    serverChannel.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
    int port = ((InetSocketAddress) serverChannel.getLocalAddress()).getPort();

    token = newToken();
    writeLocator(port);

    Thread acceptThread = new Thread(this::acceptLoop, "semantic-rpc-accept");
    acceptThread.setDaemon(true);
    acceptThread.start();

    if (idleMillis > 0) {
      Thread watchdog = new Thread(this::watchdogLoop, "semantic-rpc-watchdog");
      watchdog.setDaemon(true);
      watchdog.start();
    }
    Log.info("listening on 127.0.0.1:" + port);
  }

  /** 128-bit token（SecureRandom）→ 32 位十六进制。仅写入 locator 文件，不落日志。 */
  private static String newToken() {
    byte[] bytes = new byte[16];
    new SecureRandom().nextBytes(bytes);
    StringBuilder hex = new StringBuilder(32);
    for (byte b : bytes) hex.append(String.format("%02x", b & 0xff));
    return hex.toString();
  }

  /** 单行 JSON：{"v":1,"port":N,"token":"...","pid":N}；同目录临时文件 + ATOMIC_MOVE 原子替换。 */
  private void writeLocator(int port) throws IOException {
    JsonObject locator = new JsonObject();
    locator.addProperty("v", 1);
    locator.addProperty("port", port);
    locator.addProperty("token", token);
    locator.addProperty("pid", ProcessHandle.current().pid());
    Path tmp = locatorPath.resolveSibling(locatorPath.getFileName().toString() + ".tmp");
    Files.writeString(tmp, locator.toString(), StandardCharsets.UTF_8);
    try {
      Files.move(tmp, locatorPath, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
    } catch (IOException e) {
      Files.deleteIfExists(tmp);
      throw e;
    }
  }

  private void acceptLoop() {
    while (!stopping.get()) {
      try {
        SocketChannel channel = serverChannel.accept();
        Client client = new Client(channel, "semantic-rpc-conn-" + clientCounter.incrementAndGet());
        clients.add(client);
        Thread reader = new Thread(() -> readLoop(client), client.name);
        reader.setDaemon(true);
        reader.start();
      } catch (ClosedChannelException e) {
        return;
      } catch (IOException e) {
        if (!stopping.get()) Log.warn("accept failed: " + e);
      }
    }
  }

  private void readLoop(Client client) {
    try (BufferedReader reader =
        new BufferedReader(new InputStreamReader(Channels.newInputStream(client.channel), StandardCharsets.UTF_8))) {
      String line;
      while (!client.closed && (line = reader.readLine()) != null) {
        if (line.isBlank()) continue;
        dispatch(client, line);
      }
    } catch (IOException e) {
      // 连接断开属正常路径
    } finally {
      client.close();
      clients.remove(client);
      Log.info(client.name + " disconnected");
    }
  }

  private void dispatch(Client client, String line) {
    JsonObject request;
    try {
      request = JsonParser.parseString(line).getAsJsonObject();
    } catch (RuntimeException e) {
      client.send(errorResponse(null, -32700, "parse error", null));
      return;
    }

    JsonElement id = request.get("id");
    JsonElement methodElement = request.get("method");
    if (methodElement == null || !methodElement.isJsonPrimitive()) {
      client.send(errorResponse(id, -32600, "invalid request", null));
      return;
    }
    String method = methodElement.getAsString();
    JsonObject params =
        request.has("params") && request.get("params").isJsonObject()
            ? request.getAsJsonObject("params")
            : new JsonObject();

    boolean hello = "hello".equals(method);
    if (!client.isAuthenticated()) {
      // 每连接的第一个请求必须是 hello + 正确 token；token 不匹配或任何其它首请求 → -32019 并关闭
      if (!hello || !token.equals(readToken(params))) {
        client.send(errorResponse(id, UNAUTHORIZED, "unauthorized", null));
        client.close();
        return;
      }
      client.authenticate();
      if (id == null) return;
      lastActivity.set(System.currentTimeMillis());
      client.send(okResponse(id));
      return;
    }

    if (id == null) return; // 本协议未定义客户端通知
    lastActivity.set(System.currentTimeMillis());

    if (hello) { // hello 幂等：已认证连接重复 hello 仍返回 ok
      client.send(okResponse(id));
      return;
    }

    try {
      JsonObject result = handler.handle(client, method, params);
      JsonObject response = new JsonObject();
      response.addProperty("jsonrpc", "2.0");
      response.add("id", id);
      response.add("result", result == null ? new JsonObject() : result);
      client.send(response);
    } catch (RpcException e) {
      client.send(errorResponse(id, e.code(), e.getMessage(), e.data()));
    } catch (Throwable t) {
      Log.error("handler failed for method " + method, t);
      client.send(errorResponse(id, -32603, "internal error", null));
    }
  }

  private static String readToken(JsonObject params) {
    JsonElement token = params.get("token");
    if (token == null || !token.isJsonPrimitive() || !token.getAsJsonPrimitive().isString()) return null;
    return token.getAsString();
  }

  private static JsonObject okResponse(JsonElement id) {
    JsonObject result = new JsonObject();
    result.addProperty("ok", true);
    JsonObject response = new JsonObject();
    response.addProperty("jsonrpc", "2.0");
    response.add("id", id);
    response.add("result", result);
    return response;
  }

  private static JsonObject errorResponse(JsonElement id, int code, String message, JsonElement data) {
    JsonObject error = new JsonObject();
    error.addProperty("code", code);
    error.addProperty("message", message);
    if (data != null) error.add("data", data);
    JsonObject response = new JsonObject();
    response.addProperty("jsonrpc", "2.0");
    response.add("id", id);
    response.add("error", error);
    return response;
  }

  static JsonObject notification(String method, JsonObject params) {
    JsonObject message = new JsonObject();
    message.addProperty("jsonrpc", "2.0");
    message.addProperty("method", method);
    message.add("params", params);
    return message;
  }

  void sendNotification(Client client, String method, JsonObject params) {
    client.send(notification(method, params));
  }

  void broadcast(String method, JsonObject params) {
    JsonObject message = notification(method, params);
    for (Client client : clients) {
      if (client.isAuthenticated() && client.isSubscribed()) client.send(message);
    }
  }

  private void watchdogLoop() {
    while (!stopping.get()) {
      try {
        Thread.sleep(1000);
      } catch (InterruptedException e) {
        return;
      }
      long idle = System.currentTimeMillis() - lastActivity.get();
      if (idle >= idleMillis) {
        Log.info("idle timeout (" + idleMillis / 1000 + "s), shutting down");
        requestStop();
        return;
      }
    }
  }

  void requestStop() {
    if (!stopping.compareAndSet(false, true)) return;
    Log.info("stopping rpc server");
    try {
      if (serverChannel != null) serverChannel.close();
    } catch (IOException ignored) {
      // ignore
    }
    for (Client client : clients) client.close();
    clients.clear();
    try {
      Files.deleteIfExists(locatorPath);
    } catch (IOException e) {
      Log.warn("failed to delete locator file: " + e);
    }
    stopped.countDown();
  }

  void awaitStop() throws InterruptedException {
    stopped.await();
  }
}
