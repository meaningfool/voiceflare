import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { z } from "zod";
import { originalCascadeSelection } from "../runtimeHostComposition.ts";
import { createInterviewConversationInput } from "./testing/interviewConversationPreset.ts";
import { platformBuildOptions } from "../shared/testing/platformBuild.ts";
import type {
  ExecutionSettings,
  RuntimeReasoningEffort,
} from "../shared/contracts/runtimeStart.ts";
import { cascadeRunClient, type CascadeReceived } from "./testing/cascadeRunClient.ts";

/**
 * Cascade Original on its real provider adapters, through the real Runtime host on workerd. Most
 * scenarios choose OpenAI Responses for the model; Cascade's default model is Cerebras. Runtime selects the adapters from its own credentials and
 * calls the platform's own fetch; only the network is controlled: the Runtime worker's outbound
 * service answers as the OpenAI and Soniox endpoints, scripted by the scenario named in the
 * caller's prompt, and records what they received.
 */
let platform: Miniflare;
let script = "";
/** Durable Object storage outlives a platform, so a new platform is a Runtime restart. */
let persistence = "";

const fakeEndpoints = `
  const evidence = {};
  const record = (scenario) => (evidence[scenario] ??= { openai: [], soniox: [] });
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sse = (type, data = {}) => "event: " + type + "\\ndata: " + JSON.stringify({ type, ...data }) + "\\n\\n";
  // 100 ms of 24 kHz mono 16-bit PCM.
  const frame = () => btoa(String.fromCharCode(...new Uint8Array(4800).map((_, i) => (i * 7) % 256)));
  // The next Soniox upgrade is refused once a test asks for it.
  let refuseNextSoniox = false;
  // The next Soniox TTS or STT upgrade answers only after 30 seconds, or never once its caller
  // abandons it, once a test asks for it.
  let stallNextSoniox = false;
  let stallNextSonioxStt = false;
  // The URLs of held connections their caller abandoned.
  const abandoned = [];
  const stall = (request) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(true), 30_000);
      request.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        abandoned.push(request.url);
        resolve(false);
      });
    });

  function fakeOpenAi(request, body) {
    const prompt = body.input?.[0]?.content ?? "";
    const scenario = /scenario:([a-z-]+)/.exec(prompt)?.[1] ?? "unknown";
    const seen = record(scenario);
    seen.openai.push({ authorization: request.headers.get("Authorization"), body, at: Date.now() });
    const encoder = new TextEncoder();
    let cancelled = false;
    // The caller abandoning the response aborts its request or cancels its body.
    request.signal.addEventListener("abort", () => { cancelled = true; seen.openaiCancelledAt ??= Date.now(); });
    const stream = new ReadableStream({
      async start(controller) {
        const send = (text) => { if (!cancelled) controller.enqueue(encoder.encode(text)); };
        send(sse("response.created", { response: { id: "resp_fake" } }));
        if (scenario === "openai-http") return;
        // The model never starts to answer: the response stays in progress until abandoned.
        if (scenario === "model-stall") {
          while (!cancelled) {
            await delay(1_000);
            try { controller.enqueue(encoder.encode(sse("response.in_progress"))); }
            catch { cancelled = true; seen.openaiCancelledAt ??= Date.now(); }
          }
          return;
        }
        // After a participant turn, these speak their closing and finish in one response.
        const closes = [
          "natural-finish", "stop-finishing", "stop-finishing-detached", "closing-media-lost", "finishing-failure",
        ].includes(scenario);
        if (closes && body.input.some((item) => item.role === "user")) {
          const closing = ["Thank you. [" + scenario + "] ", "Goodbye."];
          for (const delta of closing) {
            await delay(80);
            send(sse("response.output_text.delta", { item_id: "msg_closing", delta }));
          }
          send(sse("response.output_item.done", {
            item: { id: "msg_closing", type: "message", content: [{ type: "output_text", text: closing.join("") }] },
          }));
          send(sse("response.output_item.done", {
            item: { id: "fc_closing", type: "function_call", status: "completed", call_id: "call_closing", name: "finish_interview", arguments: "{}" },
          }));
          send(sse("response.completed", {
            response: { id: "resp_closing", status: "completed", model: "gpt-fake-closing", usage: { input_tokens: 61, output_tokens: 9 } },
          }));
          controller.close();
          return;
        }
        // An opening in three message items, the second without text.
        if (scenario === "text-items") {
          const items = [["msg_a", ["Welcome. [text-items]"]], ["msg_empty", []], ["msg_b", ["What worked ", "well at the event?"]]];
          for (const [id, deltas] of items) {
            for (const delta of deltas) {
              await delay(80);
              send(sse("response.output_text.delta", { item_id: id, delta }));
            }
            send(sse("response.output_item.done", {
              item: { id, type: "message", content: [{ type: "output_text", text: deltas.join("") }] },
            }));
          }
          send(sse("response.completed", {
            response: { id: "resp_fake", status: "completed", model: "gpt-fake", usage: { input_tokens: 40, output_tokens: 12 } },
          }));
          controller.close();
          return;
        }
        // The first piece names the scenario, so the fake Soniox endpoint can script it too.
        // Gradium scenarios receive deltas split inside words, as a model can produce them.
        const pieces = scenario.startsWith("gradium-")
          ? ["Welcome. [" + scenario + "] Wh", "at wor", "ked well at the eve", "nt?"]
          : ["Welcome. [" + scenario + "] ", "What worked ", "well at ", "the event?"];
        for (const [index, delta] of pieces.entries()) {
          await delay(80);
          send(sse("response.output_text.delta", { item_id: "msg_fake", delta }));
          if (index === 0 && scenario === "stop-generation") {
            // The model keeps generating until the caller abandons the response.
            while (!cancelled) {
              await delay(100);
              try { controller.enqueue(encoder.encode(sse("response.in_progress"))); }
              catch { cancelled = true; seen.openaiCancelledAt ??= Date.now(); }
            }
            return;
          }
        }
        // Partial function-call arguments carry no authority; only the completed call counts.
        send(sse("response.function_call_arguments.delta", { item_id: "fc_fake", delta: "{" }));
        if (scenario === "openai-error" || scenario === "model-failure") {
          send(sse("response.failed", { response: { id: "resp_fake", error: { code: "server_error", message: "fake" } } }));
          controller.close();
          return;
        }
        if (scenario === "openai-dropped") { controller.close(); return; }
        send(sse("response.output_item.done", {
          item: { id: "msg_fake", type: "message", content: [{ type: "output_text", text: pieces.join("") }] },
        }));
        if (scenario === "finish")
          send(sse("response.output_item.done", {
            item: { id: "fc_fake", type: "function_call", status: "completed", call_id: "call_fake", name: "finish_interview", arguments: "{}" },
          }));
        // The bare completion of "finish" carries no usage account; the others carry one.
        send(sse("response.completed", {
          response: scenario === "finish"
            ? { id: "resp_fake", status: "completed" }
            : { id: "resp_fake", status: "completed", model: "gpt-fake", usage: { input_tokens: 40, output_tokens: 12 } },
        }));
        controller.close();
      },
      cancel() { cancelled = true; seen.openaiCancelledAt ??= Date.now(); },
    });
    if (scenario === "openai-http")
      return new Response(JSON.stringify({ error: { code: "server_error" } }), { status: 500 });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }

  async function fakeSoniox(request) {
    if (refuseNextSoniox) {
      refuseNextSoniox = false;
      return Response.json({ error_type: "unauthenticated" }, { status: 401 });
    }
    if (stallNextSoniox) {
      stallNextSoniox = false;
      if (!(await stall(request))) return new Response(null, { status: 499 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    let seen = null;
    let name = "unknown";
    const pending = [];
    let config = null;
    let audioSent = 0;
    let cancelled = false;
    const send = (message) => {
      try { server.send(JSON.stringify(message)); } catch {}
    };
    const audio = (end) => { audioSent += 1; send({ stream_id: config.stream_id, audio: frame(), audio_end: end }); };
    server.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      if (message.model !== undefined) { config = message; return pending.push(message); }
      const scenario = /\\[([a-z-]+)\\]/.exec(message.text ?? "")?.[1];
      if (seen === null && scenario !== undefined) {
        name = scenario;
        seen = record(scenario);
        seen.soniox.push({ authorization: request.headers.get("Authorization"), at: Date.now() });
        seen.soniox.push(...pending);
      }
      (seen?.soniox ?? pending).push(message);
      if (message.cancel === true) {
        cancelled = true;
        if (seen !== null) seen.sonioxCancelledAt = Date.now();
        // A provider can still have audio in flight after a cancellation.
        audio(false);
        await delay(50);
        audio(false);
        send({ stream_id: config.stream_id, terminated: true });
        return;
      }
      // "tts-silent" receives its text and never produces audio until it is cancelled.
      if (name === "tts-silent") return;
      if (message.text_end !== true) { audio(false); return; }
      if (name === "soniox-error") {
        send({ stream_id: config.stream_id, error_code: 500, error_type: "internal_error", error_message: "fake" });
        send({ stream_id: config.stream_id, terminated: true });
        return;
      }
      // A closing takes longer to deliver than its finish takes to be admitted; these take six
      // seconds, as long as Runtime's cleanup inside Live waits.
      const closing = (seen?.soniox ?? []).some((sent) => sent.text?.startsWith("Thank you."));
      const longClosing = closing && ["stop-finishing", "stop-finishing-detached", "closing-media-lost"].includes(name);
      const frames = name === "stop-synthesis" || longClosing ? 40 : closing ? 10 : 4;
      for (let index = 0; index < frames && !cancelled; index += 1) {
        await delay(name === "stop-synthesis" || closing ? 150 : 60);
        if (cancelled) break;
        if (name === "soniox-dropped" && index === 1) { server.close(1011, "fake_drop"); return; }
        if (closing && name === "finishing-failure" && index === 2) {
          send({ stream_id: config.stream_id, error_code: 500, error_type: "internal_error", error_message: "fake" });
          return;
        }
        audio(index === frames - 1);
      }
      if (cancelled) return;
      await delay(30);
      if (seen !== null) seen.sonioxTerminatedAt = Date.now();
      send({ stream_id: config.stream_id, terminated: true });
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Soniox STT. A test scripts each recognition stream through the audio it forwards: a chunk
  // whose bytes spell "cmd:<verb>:<scenario>[:<text>]" is a command; every other chunk is
  // ordinary audio, such as silence. "hear" makes "<final>|<settled>" final up to the bar,
  // without an end of turn; a finalization request then settles the rest and acknowledges.
  const recognition = [];
  async function fakeSonioxStt(request) {
    if (stallNextSonioxStt) {
      stallNextSonioxStt = false;
      if (!(await stall(request))) return new Response(null, { status: 499 });
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const stream = { scenario: null, authorization: request.headers.get("Authorization"), config: null, keepalives: 0, audioChunks: 0, finalizations: 0, ended: false, closed: false };
    let settled = "";
    recognition.push(stream);
    const send = (tokens) => { try { server.send(JSON.stringify({ tokens, final_audio_proc_ms: 0, total_audio_proc_ms: 0 })); } catch {} };
    const final = (text) => ({ text, is_final: true });
    server.addEventListener("close", () => { stream.closed = true; });
    server.addEventListener("message", async (event) => {
      if (typeof event.data === "string") {
        if (event.data === "") { stream.ended = true; return; }
        const message = JSON.parse(event.data);
        if (message.type === "keepalive") stream.keepalives += 1;
        else if (message.type === "finalize") {
          stream.finalizations += 1;
          await delay(40);
          if (stream.scenario === "settle-failure") {
            try { server.send(JSON.stringify({ tokens: [], error_code: 500, error_type: "internal_error", error_message: "fake" })); } catch {}
            server.close(1011, "fake_error");
            return;
          }
          const words = settled.length === 0 ? [] : settled.split(" ").map((word, index) => (index === 0 ? word : " " + word));
          send([...words.map(final), final("<fin>")]);
          settled = "";
        } else if (message.type === undefined) stream.config = message;
        return;
      }
      const text = new TextDecoder().decode(event.data instanceof ArrayBuffer ? event.data : await event.data.arrayBuffer());
      const command = /^cmd:([a-z-]+):([a-z-]+)(?::(.*))?$/.exec(text);
      if (command === null) { stream.audioChunks += 1; return; }
      const [, verb, scenario, said] = command;
      stream.scenario = scenario;
      const words = (said ?? "").split(" ").map((word, index) => (index === 0 ? word : " " + word));
      if (verb === "say" || verb === "say-twice") {
        // Provisional text first, then the same words final, then the end of the turn.
        send(words.slice(0, 2).map((text) => ({ text, is_final: false })));
        await delay(30);
        send(words.map(final));
        await delay(30);
        send([final("<end>")]);
        if (verb === "say-twice") { await delay(30); send([final("<end>")]); }
      }
      if (verb === "end") send([final("<end>")]);
      if (verb === "hear") {
        const [heard, rest] = (said ?? "").split("|");
        if (heard.length > 0) send(heard.split(" ").map((word, index) => final(index === 0 ? word : " " + word)));
        else send([{ text: rest.split(" ")[0], is_final: false }]);
        settled = heard.length > 0 && rest.length > 0 ? " " + rest : rest;
      }
      if (verb === "fail") {
        try { server.send(JSON.stringify({ tokens: [], error_code: 500, error_type: "internal_error", error_message: "fake" })); } catch {}
        server.close(1011, "fake_error");
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Gradium TTS. Each connection is recorded with what it received; the scenario is named by
  // the first text it received. Audio chunks have odd lengths, so samples straddle chunks.
  const gradium = [];
  let stallNextGradium = false;
  let holdNextGradiumReady = false;
  async function fakeGradium(request) {
    if (stallNextGradium) {
      stallNextGradium = false;
      if (!(await stall(request))) return new Response(null, { status: 499 });
    }
    const holdReady = holdNextGradiumReady;
    holdNextGradiumReady = false;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const connection = { scenario: null, apiKey: request.headers.get("x-api-key"), received: [], audio: [], endSentAt: null, closedAt: null };
    gradium.push(connection);
    const send = (message) => {
      if (connection.closedAt !== null) return false;
      try { server.send(JSON.stringify(message)); return true; } catch { return false; }
    };
    const audio = (bytes) => {
      const seed = connection.audio.length;
      const chunk = btoa(String.fromCharCode(...new Uint8Array(bytes).map((_, i) => (seed * 31 + i * 7) % 256)));
      if (send({ type: "audio", audio: chunk })) connection.audio.push(chunk);
    };
    const pairOfChunks = () => { audio(4801); audio(4799); };
    server.addEventListener("close", () => { connection.closedAt = Date.now(); });
    server.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      connection.received.push(message);
      if (message.type === "setup") {
        if (holdReady) return;
        await delay(20);
        send({ type: "ready", request_id: "fake", model_name: "c2752f2b@10", sample_rate: 24000, frame_size: 1920 });
        return;
      }
      if (message.type === "text") {
        connection.scenario ??= /\\[([a-z-]+)\\]/.exec(message.text)?.[1] ?? null;
        const name = connection.scenario;
        if (name === "gradium-silent") return;
        if (name === "gradium-stop") {
          if (connection.received.filter(({ type }) => type === "text").length > 1) return;
          // Synthesis keeps streaming until the connection closes.
          while (connection.closedAt === null) { audio(4800); await delay(150); }
          return;
        }
        pairOfChunks();
        // What was spoken, with timestamps: a message type the adapter ignores.
        send({ type: "text", text: message.text, start_s: 0, stop_s: 0.1 });
        return;
      }
      if (message.type === "end_of_stream") {
        const name = connection.scenario;
        if (name === "gradium-silent" || name === "gradium-stop") return;
        if (name === "gradium-error") {
          send({ type: "error", client_req_id: null, message: "fake", code: 1011 });
          server.close(1011, "fake");
          return;
        }
        await delay(40);
        pairOfChunks();
        await delay(40);
        connection.endSentAt = Date.now();
        send({ type: "end_of_stream" });
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Gradium STT. A test scripts each recognition connection through the audio it forwards, as
  // for Soniox STT: a chunk whose bytes spell "cmd:<verb>:<scenario>[:<argument>]" is a command,
  // every other chunk ordinary audio. "words" sends each word as its own text message, as
  // Gradium does, with no leading space; "steps" sends a step every 80 ms for each listed
  // inactivity probability at the 2 s horizon, the other horizons reporting its complement;
  // "tail" names the words the next flush settles before its flushed; "fail" sends an error and
  // closes; "drop" closes; "short-step" sends a step without the 2 s horizon. Messages are
  // handled in their order of arrival. The next connection never answers its setup once a test
  // asks for it.
  const gradiumRecognition = [];
  let holdNextGradiumSttReady = false;
  async function fakeGradiumStt(request) {
    const holdReady = holdNextGradiumSttReady;
    holdNextGradiumSttReady = false;
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    const connection = { scenario: null, apiKey: request.headers.get("x-api-key"), heldReady: holdReady, received: [], audioBytes: 0, stepsSent: 0, flushes: [], closed: false };
    gradiumRecognition.push(connection);
    let tail = [];
    let chain = Promise.resolve();
    const send = (message) => {
      if (connection.closed) return;
      try { server.send(JSON.stringify(message)); } catch {}
    };
    const step = (probability) => {
      connection.stepsSent += 1;
      const other = Number((1 - probability).toFixed(3));
      send({
        type: "step",
        vad: [0.5, 1, 2, 3].map((horizon_s) => ({ horizon_s, inactivity_prob: horizon_s === 2 ? probability : other })),
        step_idx: connection.stepsSent, step_duration_s: 0.08, total_duration_s: connection.stepsSent * 0.08,
      });
    };
    const handle = async (message) => {
      if (message.type === "setup") {
        if (holdReady) return;
        await delay(20);
        send({ type: "ready", request_id: "fake", model_name: "3c7a64f3@450", sample_rate: 24000, frame_size: 1920, delay_in_frames: message.json_config?.delay_in_frames, text_stream_names: ["asr_0"] });
        return;
      }
      if (message.type === "flush") {
        await delay(40);
        for (const text of tail.splice(0)) { send({ type: "text", text, start_s: 0 }); await delay(20); }
        await delay(40);
        send({ type: "flushed", flush_id: message.flush_id, client_req_id: null });
        return;
      }
      if (message.type !== "audio") return;
      const bytes = Uint8Array.from(atob(message.audio), (char) => char.charCodeAt(0));
      connection.audioBytes += bytes.length;
      const command = /^cmd:([a-z-]+):([a-z-]+)(?::(.*))?$/.exec(new TextDecoder().decode(bytes));
      if (command === null) return;
      const [, verb, scenario, argument] = command;
      connection.scenario = scenario;
      if (verb === "words")
        for (const text of argument.split(" ")) {
          send({ type: "text", text, start_s: 0 });
          send({ type: "end_text", stop_s: 0 });
          await delay(20);
        }
      if (verb === "tail") tail = argument.split(" ");
      if (verb === "steps")
        for (const probability of argument.split(",").map(Number)) { step(probability); await delay(80); }
      if (verb === "fail") {
        send({ type: "error", client_req_id: null, message: "fake", code: 1011 });
        server.close(1011, "fake");
      }
      if (verb === "drop") server.close(1011, "fake_drop");
      // A step without the 2 s horizon, as a changed Gradium could send it.
      if (verb === "short-step") send({ type: "step", vad: [{ horizon_s: 0.5, inactivity_prob: 0.9 }], step_idx: 0, step_duration_s: 0.08, total_duration_s: 0 });
    };
    server.addEventListener("close", () => { connection.closed = true; });
    server.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== "audio") connection.received.push(message);
      // A flush is recorded as it arrives, with the steps sent before it.
      if (message.type === "flush") connection.flushes.push({ flushId: message.flush_id, stepsBefore: connection.stepsSent });
      chain = chain.then(() => handle(message));
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Cerebras Chat Completions. Each request is recorded with its body and arrival time under the
  // scenario its system message names, which scripts the answer. Text after reasoning starts
  // with blank lines, as qwen's does.
  const cerebras = {};
  async function fakeCerebras(request, body) {
    const scenario = /scenario:([a-z-]+)/.exec(body.messages?.[0]?.content ?? "")?.[1] ?? "unknown";
    const seen = (cerebras[scenario] ??= { requests: [], cancelledAt: null });
    seen.requests.push({ authorization: request.headers.get("Authorization"), body, at: Date.now() });
    let cancelled = false;
    // The caller abandoning the request aborts it or cancels its body.
    request.signal.addEventListener("abort", () => { cancelled = true; seen.cancelledAt ??= Date.now(); });
    const refuse = async (code, ms = 0) => {
      await delay(ms);
      const param = code === "queue_exceeded" ? "queue" : "quota";
      return Response.json({ message: "fake", type: "too_many_requests_error", param, code }, { status: 429 });
    };
    if (scenario === "cerebras-quota") return refuse("token_quota_exceeded");
    if (scenario === "cerebras-queue-always") return refuse("queue_exceeded");
    if (scenario === "cerebras-queue-once" && seen.requests.length === 1) return refuse("queue_exceeded");
    if (scenario === "cerebras-queue-slow") return refuse("queue_exceeded", 3_000);
    const encoder = new TextEncoder();
    const data = (value) => "data: " + (typeof value === "string" ? value : JSON.stringify(value)) + "\\n\\n";
    const chunk = (delta, finish_reason, usage) => data({
      id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "qwen-fake", system_fingerprint: "fp",
      choices: [{ index: 0, delta, ...(finish_reason === undefined ? {} : { finish_reason }) }],
      ...(usage === undefined ? {} : { usage, time_info: { queue_time: 0.001 } }),
    });
    const answered = body.messages.some((message) => message.role === "user" && message.content !== "");
    const stream = new ReadableStream({
      async start(controller) {
        const send = (text) => { if (!cancelled) controller.enqueue(encoder.encode(text)); };
        send(chunk({ role: "assistant" }));
        // The model never starts to answer: the response stays open until abandoned.
        if (scenario === "cerebras-stall") {
          while (!cancelled) {
            await delay(1_000);
            try { controller.enqueue(encoder.encode(": keep-alive\\n\\n")); }
            catch { cancelled = true; seen.cancelledAt ??= Date.now(); }
          }
          return;
        }
        if (body.reasoning_effort !== "none")
          for (const reasoning of ["The participant ", "is here."]) {
            await delay(30);
            send(chunk({ reasoning }));
          }
        const closing = scenario === "cerebras-speaks" && answered;
        const pieces = closing
          ? ["\\n\\n", "Thank you. [" + scenario + "] ", "Goodbye."]
          : ["\\n\\n", "Welcome. [" + scenario + "] ", "What worked ", "well at ", "the event?"];
        for (const content of pieces) {
          await delay(60);
          send(chunk({ content }));
        }
        if (scenario === "cerebras-dropped") { controller.close(); return; }
        if (closing) {
          send(chunk({ tool_calls: [{ index: 0, id: "call_closing", type: "function", function: { name: "finish_interview", arguments: "{}" } }] }));
          send(chunk({}, "tool_calls", { prompt_tokens: 61, completion_tokens: 9 }));
        } else
          send(chunk({}, scenario === "cerebras-length" ? "length" : "stop", { prompt_tokens: 40, completion_tokens: 12 }));
        send(data("[DONE]"));
        controller.close();
      },
      cancel() { cancelled = true; seen.cancelledAt ??= Date.now(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  }

  export default { async fetch(request) {
    if (request.url === "https://api.cerebras.ai/v1/chat/completions")
      return fakeCerebras(request, await request.json());
    if (request.url === "https://fakes.test/cerebras") return Response.json(cerebras);
    if (request.url === "https://api.gradium.ai/api/speech/tts") return fakeGradium(request);
    if (request.url === "https://api.gradium.ai/api/speech/asr") return fakeGradiumStt(request);
    if (request.url === "https://fakes.test/gradium-stt") return Response.json(gradiumRecognition);
    if (request.url === "https://fakes.test/fakes/hold-next-gradium-stt-ready") {
      holdNextGradiumSttReady = true;
      return new Response(null, { status: 204 });
    }
    if (request.url === "https://fakes.test/gradium") return Response.json(gradium);
    if (request.url === "https://fakes.test/fakes/stall-next-gradium") {
      stallNextGradium = true;
      return new Response(null, { status: 204 });
    }
    if (request.url === "https://fakes.test/fakes/hold-next-gradium-ready") {
      holdNextGradiumReady = true;
      return new Response(null, { status: 204 });
    }
    const url = new URL(request.url);
    if (url.href === "https://stt-rt.soniox.com/transcribe-websocket") return fakeSonioxStt(request);
    if (url.href === "https://fakes.test/recognition") return Response.json(recognition);
    if (url.href === "https://api.openai.com/v1/responses")
      return fakeOpenAi(request, await request.json());
    if (url.href === "https://tts-rt.soniox.com/tts-websocket") return fakeSoniox(request);
    if (url.href === "https://fakes.test/fakes") return Response.json(evidence);
    if (url.href === "https://fakes.test/fakes/refuse-next-soniox") {
      refuseNextSoniox = true;
      return new Response(null, { status: 204 });
    }
    if (url.href === "https://fakes.test/fakes/stall-next-soniox") {
      stallNextSoniox = true;
      return new Response(null, { status: 204 });
    }
    if (url.href === "https://fakes.test/fakes/stall-next-soniox-stt") {
      stallNextSonioxStt = true;
      return new Response(null, { status: 204 });
    }
    if (url.href === "https://fakes.test/fakes/abandoned") return Response.json(abandoned);
    return new Response("unexpected outbound request", { status: 599 });
  }};
`;

beforeAll(async () => {
  const bundle = await build({
    ...platformBuildOptions,
    stdin: {
      contents: `
        import { InterviewRuntimeController } from "./worker/runtime/interviewRuntimeController.ts";
        import { createRuntimeHostDelivery } from "./worker/runtimeHostDelivery.ts";
        import { createRuntimeHostAssembly } from "./worker/runtimeHostComposition.ts";
        import { readFinalizationTranscriptTurns } from "./worker/runtime/interviewFinalizationModel.ts";
        export class Controller extends InterviewRuntimeController {
          constructor(ctx, env) {
            super(ctx, env, {
              // No stand-ins: Runtime selects the real adapters from its credentials.
              assembly: createRuntimeHostAssembly(),
              delivery: createRuntimeHostDelivery(env),
            });
          }
          // The Run's published transcript and canonical result, as delivery would send them;
          // these scenarios configure no result delivery.
          async fetch(request) {
            // The Run's physical alarm, as the platform would invoke it.
            if (new URL(request.url).pathname === "/run-alarm") {
              await this.ready;
              await this.alarm();
              return Response.json({ ok: true });
            }
            if (new URL(request.url).pathname !== "/result") return super.fetch(request);
            await this.ready;
            const aggregate = this.repository.readAggregate(this.repository.requireState());
            return Response.json({
              turns: readFinalizationTranscriptTurns(aggregate),
              result: aggregate.applicationTranscriptProof.result ?? null,
            });
          }
        }
        export default { fetch(request, env) {
          const url = new URL(request.url);
          // The test reaches the fake endpoints through the Runtime worker's outbound service.
          if (url.pathname.startsWith("/fakes") || url.pathname === "/recognition" || url.pathname === "/gradium" || url.pathname === "/gradium-stt" || url.pathname === "/cerebras")
            return fetch("https://fakes.test" + url.pathname);
          return env.CONTROLLER.getByName(url.searchParams.get("controller")).fetch(request);
        }};`,
      resolveDir: process.cwd(),
    },
  });
  script = bundle.outputFiles[0]?.text ?? "";
  persistence = await mkdtemp(join(tmpdir(), "cascade-endings-"));
  platform = createPlatform();
}, 30_000);

function createPlatform() {
  return new Miniflare({
    durableObjectsPersist: persistence,
    workers: [
      {
        name: "runtime",
        modules: true,
        script,
        compatibilityDate: "2026-06-05",
        compatibilityFlags: ["nodejs_compat", "enable_request_signal"],
        durableObjects: { CONTROLLER: { className: "Controller", useSQLite: true } },
        bindings: {
          OPENAI_API_KEY: "sk-fake-openai",
          SONIOX_API_KEY: "fake-soniox",
          GRADIUM_API_KEY: "fake-gradium",
          CEREBRAS_API_KEY: "fake-cerebras",
        },
        outboundService: "providers",
      },
      {
        name: "providers",
        modules: true,
        script: fakeEndpoints,
        compatibilityDate: "2026-06-05",
        compatibilityFlags: ["enable_request_signal"],
      },
    ],
  });
}

afterAll(async () => {
  await platform?.dispose();
  if (persistence !== "") await rm(persistence, { recursive: true, force: true });
});

const finishDescription = "Call this tool once the participant answered the question.";
const promptFor = (scenario: string) =>
  `Say Welcome. Then ask what worked well at the event. scenario:${scenario}`;

const client = cascadeRunClient(() => platform);
const { request, post, state: readState } = client;

const fakesSchema = z.record(
  z.string(),
  z.object({
    openai: z.array(
      z.object({ authorization: z.string().nullable(), body: z.json(), at: z.number() }),
    ),
    soniox: z.array(z.json()),
    openaiCancelledAt: z.number().optional(),
    sonioxCancelledAt: z.number().optional(),
    sonioxTerminatedAt: z.number().optional(),
  }),
);
async function fakes(scenario: string) {
  const all = fakesSchema.parse(
    await (await platform.dispatchFetch("https://probe.test/fakes")).json(),
  );
  const seen = all[scenario];
  if (seen === undefined) throw new Error(`The fake endpoints saw no ${scenario} request`);
  return seen;
}

type Received = CascadeReceived;

/** Starts a Run, attaches its media as the Lab page does, and reports media readiness. */
async function goLive(scenario: string) {
  return (await attachLive(scenario)).received;
}

/**
 * Starts a Run whose model is OpenAI Responses, which most scenarios script, unless its settings
 * choose another or it runs on Cascade's defaults (`onDefaults`).
 */
async function attachLive(
  scenario: string,
  options: Readonly<{
    interviewingDurationMs?: number;
    mediaReady?: boolean;
    executionSettings?: Readonly<Record<string, ExecutionSettings>>;
    onDefaults?: true;
    reasoningEffort?: RuntimeReasoningEffort;
  }> = {},
) {
  const run = {
    selection: originalCascadeSelection,
    agentInput: createInterviewConversationInput(
      promptFor(scenario),
      finishDescription,
      options.interviewingDurationMs,
    ),
    executionSettings:
      options.onDefaults === true
        ? options.executionSettings
        : { languageModel: { provider: "openai" }, ...options.executionSettings },
    reasoningEffort: options.reasoningEffort,
  };
  return options.mediaReady === false
    ? client.attachLive(scenario, run)
    : client.goLive(scenario, run);
}

const kinds = (received: readonly Received[]) => received.map(({ message }) => message.type);

describe("Cascade Original opening on the OpenAI Responses and Soniox adapters", () => {
  it("streams the generated opening to the browser while its synthesis is still running", async () => {
    const received = await goLive("normal");
    await expect
      .poll(() => kinds(received).includes("output.ended"), { timeout: 15_000 })
      .toBe(true);
    const seen = await fakes("normal");

    // The model request carries the caller's prompt and tool wording verbatim, streams and
    // is not stored.
    expect(seen.openai).toHaveLength(1);
    expect(seen.openai[0]?.authorization).toBe("Bearer sk-fake-openai");
    expect(seen.openai[0]?.body).toEqual({
      model: "gpt-5.4-mini-2026-03-17",
      stream: true,
      store: false,
      input: [{ role: "developer", content: promptFor("normal") }],
      tools: [
        {
          type: "function",
          name: "finish_interview",
          description: finishDescription,
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
        },
      ],
      tool_choice: "auto",
      reasoning: { effort: "none" },
    });

    // One synthesis stream receives the model's text as it streams, then an explicit end.
    const [authorization, config, ...texts] = seen.soniox;
    expect(authorization).toMatchObject({ authorization: "Bearer fake-soniox" });
    const streamId = z.object({ stream_id: z.string() }).parse(config).stream_id;
    expect(streamId).toMatch(/^cascade_synthesis_/);
    expect(config).toEqual({
      stream_id: streamId,
      model: "tts-rt-v2",
      language: "en",
      voice: "Adrian",
      audio_format: "pcm_s16le",
      sample_rate: 24_000,
    });
    expect(texts).toEqual([
      ...["Welcome. [normal] ", "What worked ", "well at ", "the event?"].map((text) => ({
        stream_id: streamId,
        text,
        text_end: false,
      })),
      { stream_id: streamId, text: "", text_end: true },
    ]);

    // The browser receives the identified opening in order, starting before synthesis
    // terminated, and its explicit end after it.
    const messages = received.flatMap(({ message }) =>
      message.type.startsWith("output.") ? [message] : [],
    );
    const outputId = messages[0]?.type === "output.started" ? messages[0].outputId : null;
    expect(outputId).not.toBeNull();
    const audio = messages.filter((message) => message.type === "output.audio");
    expect(audio.map(({ sequence }) => sequence)).toEqual(audio.map((_, index) => index));
    expect(audio).toHaveLength(8);
    expect(messages.at(-1)).toEqual({ type: "output.ended", outputId, chunkCount: 8 });
    const firstAudio = received.find(({ message }) => message.type === "output.audio")?.at ?? 0;
    expect(firstAudio).toBeLessThan(seen.sonioxTerminatedAt ?? 0);
    // The Run's diagnostics show the providers and settings it used: today's, with Soniox's own
    // defaults for the turn-detection settings Cascade does not send.
    expect((await readState("normal")).settingsSummary).toEqual({
      model: "cascade-v1/original-interview",
      maxOutputTokens: "inf",
      languageModel: { provider: "openai", model: "gpt-5.4-mini-2026-03-17" },
      speechInput: {
        provider: "soniox",
        model: "stt-rt-v5",
        endpointSensitivity: -0.3,
        maxEndpointDelayMs: null,
        endpointLatencyAdjustmentLevel: null,
      },
      speechOutput: { provider: "soniox", model: "tts-rt-v2", voice: "Adrian" },
    });

    expect((await post("normal", "/complete", { endReason: "participant_stopped" })).ok).toBe(true);
    await expect
      .poll(async () => readState("normal"), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "participant_stopped" } });
  }, 40_000);

  it("speaks and saves a response's text items joined with a single space", async () => {
    const received = await goLive("text-items");
    await expect
      .poll(() => kinds(received).includes("output.ended"), { timeout: 15_000 })
      .toBe(true);
    const texts = (await fakes("text-items")).soniox.flatMap((message) =>
      typeof message === "object" && message !== null && "text" in message ? [message.text] : [],
    );
    expect(texts).toEqual(["Welcome. [text-items]", " What worked ", "well at the event?", ""]);

    expect((await post("text-items", "/complete", { endReason: "participant_stopped" })).ok).toBe(
      true,
    );
    await expect
      .poll(async () => readState("text-items"), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "participant_stopped" } });
    expect((await readResult("text-items")).turns).toEqual([
      { role: "conversationAgent", text: "Welcome. [text-items] What worked well at the event?" },
    ]);
  }, 40_000);

  it("reports the response's completed tool call, which finishes the interview", async () => {
    const received = await goLive("finish");
    // The completed finish_interview call reaches Conversation apart from the spoken text.
    await expect
      .poll(async () => readState("finish"), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "agent_requested_end" } });
    expect((await fakes("finish")).openai).toHaveLength(1);
    expect(kinds(received)).not.toContain("output.failed");
    // OpenAI completed the response without its account of the tokens: that response's usage
    // is unknown, so the usage is incomplete and names no language model entry.
    const { runtimeUsage } = (await readResult("finish")).result;
    expect(runtimeUsage.completeness).toBe("incomplete");
    expect(runtimeUsage.observations).not.toContainEqual(
      expect.objectContaining({ componentRole: "language_model" }),
    );
  }, 40_000);

  it.each([
    ["stop-generation", "while the model is still generating"],
    ["stop-synthesis", "while synthesis is still streaming"],
  ])(
    "cancels generation and synthesis at Stop %s and delivers no later audio",
    async (scenario) => {
      const received = await goLive(scenario);
      await expect
        .poll(() => received.filter(({ message }) => message.type === "output.audio").length, {
          timeout: 15_000,
        })
        .toBeGreaterThan(scenario === "stop-synthesis" ? 3 : 0);
      expect((await post(scenario, "/complete", { endReason: "participant_stopped" })).ok).toBe(
        true,
      );
      await expect
        .poll(async () => readState(scenario), { timeout: 20_000 })
        .toMatchObject({ phase: "ended", completion: { endReason: "participant_stopped" } });
      // Both providers were cancelled: the model's stream was abandoned and the synthesis
      // stream received its cancellation.
      if (scenario === "stop-generation")
        await expect
          .poll(async () => (await fakes(scenario)).openaiCancelledAt, { timeout: 10_000 })
          .toBeDefined();
      const seen = await fakes(scenario);
      if (scenario === "stop-synthesis") expect(seen.openaiCancelledAt).toBeUndefined();
      expect(seen.sonioxCancelledAt).toBeDefined();
      expect(seen.soniox.at(-1)).toMatchObject({ cancel: true });
      expect(Object.keys(seen.soniox.at(-1) ?? {}).sort()).toEqual(["cancel", "stream_id"]);
      // The provider's audio after its cancellation never reaches the browser.
      const cancelled = kinds(received).indexOf("output.cancelled");
      expect(cancelled).toBeGreaterThan(0);
      expect(received.slice(cancelled + 1)).toEqual([]);
      expect(kinds(received)).not.toContain("output.ended");
      expect(seen.openai).toHaveLength(1);
      // The interviewer turn is the text submitted for synthesis before Stop cut it short.
      const saved = await readResult(scenario);
      expect(saved.turns).toEqual([
        {
          role: "conversationAgent",
          text:
            scenario === "stop-generation"
              ? "Welcome. [stop-generation]"
              : "Welcome. [stop-synthesis] What worked well at the event?",
        },
      ]);
      expect(saved.warnings).toEqual([]);
      // Stop cut the model's response before OpenAI's account of it in "stop-generation", so
      // its usage is unknown. In "stop-synthesis" the response had completed: its account and
      // the synthesis's text and delivered audio make the usage complete.
      const usage = saved.result.runtimeUsage;
      const languageModel = {
        componentRole: "language_model",
        provider: "openai",
        model: "gpt-fake",
      };
      const speechOutput = {
        componentRole: "text_to_speech",
        provider: "soniox",
        model: "tts-rt-v2",
      };
      if (scenario === "stop-generation") {
        expect(usage.completeness).toBe("incomplete");
        expect(usage.observations).not.toContainEqual(
          expect.objectContaining({ componentRole: "language_model" }),
        );
      } else {
        // The audio delivered depends on when Stop cut synthesis: Cascade's own record of it.
        const [spoken] = await records(scenario, "cascade.speech_output_usage");
        const deliveredMs = z.number().int().positive().parse(spoken?.audioMs);
        expect(usage).toEqual({
          completeness: "complete",
          observations: [
            { ...languageModel, measure: "input_text", unit: "token", quantity: 40 },
            { ...languageModel, measure: "output_text", unit: "token", quantity: 12 },
            {
              ...speechOutput,
              measure: "input_text",
              unit: "character",
              quantity: "Welcome. [stop-synthesis] What worked well at the event?".length,
            },
            {
              ...speechOutput,
              measure: "output_audio",
              unit: "audio_millisecond",
              quantity: deliveredMs,
            },
          ],
        });
      }
    },
    40_000,
  );

  it.each([
    ["openai-error", "openai_response_failed:server_error"],
    ["openai-dropped", "openai_stream_closed"],
    ["openai-http", "openai_http_500"],
    ["soniox-error", "soniox_internal_error"],
    ["soniox-dropped", "soniox_connection_closed"],
    ["soniox-refused", "soniox_http_401"],
  ])(
    "fails the output, never completing it, on %s",
    async (scenario, code) => {
      if (scenario === "soniox-refused")
        expect(
          (await platform.dispatchFetch("https://probe.test/fakes/refuse-next-soniox")).status,
        ).toBe(204);
      const received = await goLive(scenario);
      await expect
        .poll(() => kinds(received).includes("output.failed"), { timeout: 15_000 })
        .toBe(true);
      expect(received.at(-1)?.message).toMatchObject({ type: "output.failed", code });
      expect(kinds(received)).not.toContain("output.ended");
      // The provider failure ends participation as a Runtime failure, never a normal finish.
      await expect
        .poll(async () => readState(scenario), { timeout: 20_000 })
        .toMatchObject({ phase: "ended", completion: { endReason: "runtime_failed" } });
    },
    40_000,
  );
});

const recognitionSchema = z.array(
  z.object({
    scenario: z.string().nullable(),
    authorization: z.string().nullable(),
    config: z.json(),
    keepalives: z.number(),
    audioChunks: z.number(),
    finalizations: z.number(),
    ended: z.boolean(),
    closed: z.boolean(),
  }),
);
async function allRecognition() {
  return recognitionSchema.parse(
    await (await platform.dispatchFetch("https://probe.test/recognition")).json(),
  );
}
/** How many recognition streams the fake Soniox STT endpoint saw, for any scenario. */
async function recognitionStreamCount() {
  return (await allRecognition()).length;
}
/** The recognition streams the fake Soniox STT endpoint saw for a scenario. */
async function recognition(scenario: string) {
  const all = await allRecognition();
  return all.filter((stream) => stream.scenario === scenario);
}

/** Sends participant audio as the Lab page does, for the listening opportunity it names. */
function sendAudio(
  socket: { send(data: string): void },
  opportunityId: string,
  audio: Uint8Array | string,
) {
  const bytes = typeof audio === "string" ? new TextEncoder().encode(audio) : audio;
  socket.send(
    JSON.stringify({
      type: "input.audio",
      opportunityId,
      audio: btoa(String.fromCharCode(...bytes)),
    }),
  );
}
/** 100 ms of input silence. */
const silence = new Uint8Array(3_200);

/** The listening opportunities the browser was offered, in order. */
function opportunities(received: readonly Received[]) {
  return received.flatMap(({ message }) => (message.type === "input.listening" ? [message] : []));
}
function outputIds(received: readonly Received[]) {
  return received.flatMap(({ message }) =>
    message.type === "output.started" ? [message.outputId] : [],
  );
}

const diagnosticsSchema = z.object({
  records: z.array(z.object({ type: z.string(), payloadJson: z.string() })),
});
/** The Run's retained Runtime records of one type, with their payloads. */
async function records(runId: string, type: string) {
  const { records } = diagnosticsSchema.parse(
    await (await request(runId, `/diagnostics?runId=${runId}`)).json(),
  );
  return records
    .filter((record) => record.type === type)
    .map((record) => z.record(z.string(), z.json()).parse(JSON.parse(record.payloadJson)));
}

const transcriptStateSchema = z.object({
  state: z.object({
    transcript: z.object({ turnCount: z.number() }),
    completion: z.object({ warnings: z.array(z.string()) }).nullable(),
  }),
});

const resultSchema = z.object({
  turns: z.array(z.object({ role: z.string(), text: z.string() })),
  result: z.object({
    outcome: z.string(),
    reason: z.string().optional(),
    transcriptCompleteness: z.string(),
    transcriptIncompleteReasons: z.array(z.json()),
    runtimeUsage: z.object({ completeness: z.string(), observations: z.array(z.json()) }),
  }),
});
/** The Run's published transcript turns, its canonical result and its completion warnings. */
async function readResult(runId: string) {
  const published = resultSchema.parse(await (await request(runId, "/result")).json());
  const { state } = transcriptStateSchema.parse(await (await request(runId, "/state")).json());
  return { ...published, warnings: state.completion?.warnings };
}

async function stop(runId: string) {
  expect((await post(runId, "/complete", { endReason: "participant_stopped" })).ok).toBe(true);
  await expect
    .poll(async () => readState(runId), { timeout: 20_000 })
    .toMatchObject({ phase: "ended", completion: { endReason: "participant_stopped" } });
}

/** Waits while the page reports its presence, as the Lab page does every few seconds. */
async function waitPresent(runId: string, ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    expect((await post(runId, "/presence", { mediaPresent: true })).ok).toBe(true);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Math.min(4_000, until - Date.now()))),
    );
  }
}

/** Waits for the opportunity after the opening and returns it. */
async function firstOpportunity(received: readonly Received[]) {
  await expect.poll(() => opportunities(received).length, { timeout: 15_000 }).toBe(1);
  const opportunity = opportunities(received)[0];
  if (opportunity === undefined) throw new Error("Missing the listening opportunity");
  return opportunity;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 600));

describe("Cascade Original participant turns on Soniox STT", () => {
  it("admits one turn at the end-of-turn signal and streams the next response with the history", async () => {
    const { received, socket } = await attachLive("turn");
    // Audio sent while the opening plays names no open opportunity, so it is discarded.
    sendAudio(socket, "cascade_listening_not_offered", "cmd:say:turn:Sent during playback.");
    const first = await firstOpportunity(received);
    const [opening] = outputIds(received);
    expect(first.afterOutputId).toBe(opening);
    // Incremental audio with pauses: the turn ends only at the provider's signal.
    for (let index = 0; index < 3; index += 1) sendAudio(socket, first.opportunityId, silence);
    sendAudio(socket, first.opportunityId, "cmd:say:turn:The talks were clear and the room");
    for (let index = 0; index < 3; index += 1) sendAudio(socket, first.opportunityId, silence);
    await expect.poll(() => opportunities(received).length, { timeout: 15_000 }).toBe(2);
    // The turn closed listening before the next response started.
    const closed = kinds(received).indexOf("input.closed");
    expect(received[closed]?.message).toEqual({
      type: "input.closed",
      opportunityId: first.opportunityId,
    });
    expect(kinds(received)[closed + 1]).toBe("output.started");
    const seen = await fakes("turn");
    expect(seen.openai).toHaveLength(2);
    // The history carries the generated opening and the utterance that stopped mid-sentence.
    expect(z.object({ input: z.json() }).parse(seen.openai[1]?.body).input).toEqual([
      { role: "developer", content: promptFor("turn") },
      { role: "assistant", content: "Welcome. [turn] What worked well at the event?" },
      { role: "user", content: "The talks were clear and the room" },
    ]);
    const [, next] = outputIds(received);
    expect(opportunities(received)[1]?.afterOutputId).toBe(next);
    // A closed opportunity's audio admits nothing.
    sendAudio(socket, first.opportunityId, "cmd:say:turn:A stale answer.");
    await settle();
    expect((await fakes("turn")).openai).toHaveLength(2);

    await stop("turn");
    const state = transcriptStateSchema.parse(await (await request("turn", "/state")).json());
    // Interviewer, participant, interviewer.
    expect(state.state.transcript.turnCount).toBe(3);
    expect(state.state.completion?.warnings).toEqual([]);
    expect(await records("turn", "cascade.listening_closed")).toEqual([
      expect.objectContaining({
        opportunityId: first.opportunityId,
        acceptedChunks: 7,
        discardedChunks: 1,
      }),
      expect.objectContaining({ acceptedChunks: 0, discardedChunks: 2 }),
    ]);
    const [stream] = await recognition("turn");
    expect(stream).toMatchObject({
      authorization: "Bearer fake-soniox",
      audioChunks: 6,
      ended: true,
    });
    // A Run started without settings sends today's recognition configuration, and nothing more.
    expect(stream?.config).toEqual({
      model: "stt-rt-v5",
      language_hints: ["en"],
      enable_endpoint_detection: true,
      endpoint_sensitivity: -0.3,
      audio_format: "pcm_s16le",
      sample_rate: 16_000,
      num_channels: 1,
    });
  }, 60_000);

  it("admits no turn for an empty end of turn and only one for a repeated end", async () => {
    const { received, socket } = await attachLive("empty-end");
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, "cmd:end:empty-end");
    await settle();
    expect(kinds(received)).not.toContain("input.closed");
    expect((await fakes("empty-end")).openai).toHaveLength(1);
    expect(await records("empty-end", "cascade.turn_ignored")).toEqual([
      expect.objectContaining({ opportunityId: first.opportunityId, reason: "empty" }),
    ]);
    // The same opportunity still takes the answer; the repeated end admits nothing more.
    sendAudio(socket, first.opportunityId, "cmd:say-twice:empty-end:Clear talks.");
    await expect.poll(() => opportunities(received).length, { timeout: 15_000 }).toBe(2);
    await settle();
    const seen = await fakes("empty-end");
    expect(seen.openai).toHaveLength(2);
    expect(z.object({ input: z.json() }).parse(seen.openai[1]?.body).input).toEqual([
      { role: "developer", content: promptFor("empty-end") },
      { role: "assistant", content: "Welcome. [empty-end] What worked well at the event?" },
      { role: "user", content: "Clear talks." },
    ]);
    expect(await records("empty-end", "cascade.turn_admitted")).toHaveLength(1);
    await stop("empty-end");
  }, 60_000);

  it("waits through silence of any length with keepalives and admits no turn", async () => {
    const { received, socket } = await attachLive("long-silence");
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, "cmd:tag:long-silence");
    // No audio while the browser still plays the opening, then ordinary silence: together
    // longer than every provider step's time limit.
    await waitPresent("long-silence", 16_000);
    for (let index = 0; index < 20; index += 1) sendAudio(socket, first.opportunityId, silence);
    await settle();
    const [stream] = await recognition("long-silence");
    expect(stream?.keepalives).toBeGreaterThanOrEqual(1);
    expect(stream?.audioChunks).toBe(20);
    expect(stream?.closed).toBe(false);
    expect(kinds(received)).not.toContain("input.closed");
    expect((await readState("long-silence")).phase).toBe("live");
    expect((await fakes("long-silence")).openai).toHaveLength(1);
    await stop("long-silence");
    await expect
      .poll(async () => (await recognition("long-silence"))[0]?.closed, { timeout: 10_000 })
      .toBe(true);
  }, 60_000);

  it("ends the Run as a Runtime failure when speech input fails", async () => {
    const { received, socket } = await attachLive("stt-failure");
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, "cmd:fail:stt-failure");
    await expect
      .poll(async () => readState("stt-failure"), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "runtime_failed" } });
    expect(await records("stt-failure", "cascade.input_failed")).toEqual([
      expect.objectContaining({ code: "soniox_internal_error" }),
    ]);
  }, 60_000);
});

describe("Cascade settings given at Start", () => {
  /**
   * Every Cascade setting, each away from today's value where its list allows another; the model
   * names OpenAI, whose fake these scenarios script.
   */
  const everySetting = {
    languageModel: { provider: "openai", model: "gpt-5.4-mini-2026-03-17" },
    speechInput: {
      model: "stt-rt-v6",
      endpointSensitivity: 0.4,
      maxEndpointDelayMs: 2_500,
      endpointLatencyAdjustmentLevel: 2,
    },
    speechOutput: { model: "tts-rt-v2", voice: "Nina" },
  };

  it("sends each given setting to its provider and shows them in the Run's diagnostics", async () => {
    const { received, socket } = await attachLive("settings-given", {
      executionSettings: everySetting,
    });
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, "cmd:say:settings-given:The talks were clear.");
    await expect.poll(() => opportunities(received).length, { timeout: 15_000 }).toBe(2);
    const seen = await fakes("settings-given");
    expect(
      seen.openai.map(({ body }) => z.object({ model: z.string() }).parse(body).model),
    ).toEqual(["gpt-5.4-mini-2026-03-17", "gpt-5.4-mini-2026-03-17"]);
    const synthesis = seen.soniox.filter(
      (message) => typeof message === "object" && message !== null && "model" in message,
    );
    expect(synthesis).toEqual([
      expect.objectContaining({ model: "tts-rt-v2", language: "en", voice: "Nina" }),
      expect.objectContaining({ model: "tts-rt-v2", language: "en", voice: "Nina" }),
    ]);
    const [stream] = await recognition("settings-given");
    expect(stream?.config).toEqual({
      model: "stt-rt-v6",
      language_hints: ["en"],
      enable_endpoint_detection: true,
      endpoint_sensitivity: 0.4,
      max_endpoint_delay_ms: 2_500,
      endpoint_latency_adjustment_level: 2,
      audio_format: "pcm_s16le",
      sample_rate: 16_000,
      num_channels: 1,
    });
    // Speech groups that name no provider are today's providers', which the summary names.
    expect((await readState("settings-given")).settingsSummary).toEqual({
      model: "cascade-v1/original-interview",
      maxOutputTokens: "inf",
      languageModel: everySetting.languageModel,
      speechInput: { provider: "soniox", ...everySetting.speechInput },
      speechOutput: { provider: "soniox", ...everySetting.speechOutput },
    });

    await stop("settings-given");
    // The speech providers' usage names the models the Run used.
    const usage = z
      .array(z.object({ componentRole: z.string(), model: z.string() }))
      .parse((await readResult("settings-given")).result.runtimeUsage.observations);
    expect(
      new Set(
        usage
          .filter(({ componentRole }) => componentRole !== "language_model")
          .map(({ componentRole, model }) => `${componentRole}:${model}`),
      ),
    ).toEqual(new Set(["speech_to_text:stt-rt-v6", "text_to_speech:tts-rt-v2"]));
  }, 60_000);

  it("sends each provider's messages when the start names Soniox, OpenAI and Soniox", async () => {
    const { received, socket } = await attachLive("settings-named", {
      executionSettings: {
        languageModel: { provider: "openai" },
        speechInput: { provider: "soniox" },
        speechOutput: { provider: "soniox" },
      },
    });
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, "cmd:say:settings-named:The talks were clear.");
    await expect.poll(() => opportunities(received).length, { timeout: 15_000 }).toBe(2);
    const seen = await fakes("settings-named");
    expect(seen.openai[0]?.authorization).toBe("Bearer sk-fake-openai");
    expect(seen.openai[0]?.body).toEqual({
      model: "gpt-5.4-mini-2026-03-17",
      stream: true,
      store: false,
      input: [{ role: "developer", content: promptFor("settings-named") }],
      tools: [
        {
          type: "function",
          name: "finish_interview",
          description: finishDescription,
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: false,
        },
      ],
      tool_choice: "auto",
      reasoning: { effort: "none" },
    });
    const [authorization, config] = seen.soniox;
    expect(authorization).toMatchObject({ authorization: "Bearer fake-soniox" });
    const streamId = z.object({ stream_id: z.string() }).parse(config).stream_id;
    expect(config).toEqual({
      stream_id: streamId,
      model: "tts-rt-v2",
      language: "en",
      voice: "Adrian",
      audio_format: "pcm_s16le",
      sample_rate: 24_000,
    });
    const [stream] = await recognition("settings-named");
    expect(stream).toMatchObject({ authorization: "Bearer fake-soniox" });
    expect(stream?.config).toEqual({
      model: "stt-rt-v5",
      language_hints: ["en"],
      enable_endpoint_detection: true,
      endpoint_sensitivity: -0.3,
      audio_format: "pcm_s16le",
      sample_rate: 16_000,
      num_channels: 1,
    });
    await stop("settings-named");
  }, 60_000);

  it.each([
    ["settings-unknown", { speechOutput: { voice: "Nina", speed: 1.1 } }],
    ["settings-out-of-range", { speechInput: { maxEndpointDelayMs: 3_500 } }],
    ["settings-unknown-provider", { speechOutput: { provider: "elevenlabs" } }],
    ["settings-other-provider", { speechInput: { provider: "soniox", voice: "Nina" } }],
    ["settings-other-provider-voice", { speechOutput: { provider: "gradium", voice: "Adrian" } }],
  ])(
    "refuses settings Cascade does not accept before any provider work (%s)",
    async (scenario, executionSettings) => {
      const streams = await recognitionStreamCount();
      const response = await client.start(scenario, {
        selection: originalCascadeSelection,
        agentInput: createInterviewConversationInput(promptFor(scenario), finishDescription),
        executionSettings,
      });
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 400,
        body: {
          runId: scenario,
          exchangeId: `exchange-${scenario}`,
          acceptance: "not_accepted",
          error: "invalid_execution_settings",
        },
      });
      // No Run was set up, so nothing can attach media or reach a provider.
      const attachment = await request(scenario, `/attachment?runId=${scenario}`, {
        headers: { Upgrade: "websocket" },
      });
      expect(attachment.webSocket).toBeNull();
      await settle();
      const evidence = z
        .record(z.string(), z.json())
        .parse(await (await platform.dispatchFetch("https://probe.test/fakes")).json());
      expect(Object.keys(evidence)).not.toContain(scenario);
      expect(await recognitionStreamCount()).toBe(streams);
    },
    30_000,
  );
});

describe("Cascade Original's natural finish and input closure", () => {
  it("delivers the closing spoken with finish_interview, then ends as the agent requested", async () => {
    const { received, socket } = await attachLive("natural-finish");
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, "cmd:say:natural-finish:The talks were clear.");
    await expect.poll(() => outputIds(received).length, { timeout: 15_000 }).toBe(2);
    const [opening, closing] = outputIds(received);
    // Audio the browser sends while the closing plays names a closed opportunity.
    sendAudio(socket, first.opportunityId, "cmd:say:natural-finish:A late answer.");
    await expect
      .poll(async () => readState("natural-finish"), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "agent_requested_end" } });
    // The closing's speech was delivered in full, not cancelled when the finish was admitted.
    const closingMessages = received.flatMap(({ message }) =>
      "outputId" in message && message.outputId === closing ? [message.type] : [],
    );
    expect(closingMessages.at(-1)).toBe("output.ended");
    // One chunk per text piece synthesized, then ten for the end of the text.
    expect(closingMessages.filter((type) => type === "output.audio")).toHaveLength(12);
    expect(kinds(received)).not.toContain("output.cancelled");
    // Ending's containment after the finish finds the closing delivered: nothing is cancelled.
    expect(await records("natural-finish", "cascade.output_cancelled")).toEqual([]);
    // Participant input closed with the finish: no further listening, turn or response.
    expect(opportunities(received)).toHaveLength(1);
    expect((await fakes("natural-finish")).openai).toHaveLength(2);
    expect(await recognition("natural-finish")).toHaveLength(1);
    expect(await records("natural-finish", "cascade.turn_admitted")).toHaveLength(1);

    // Interviewer turns are the text submitted for synthesis.
    const saved = await readResult("natural-finish");
    expect(saved.turns).toEqual([
      {
        role: "conversationAgent",
        text: "Welcome. [natural-finish] What worked well at the event?",
      },
      { role: "participant", text: "The talks were clear." },
      { role: "conversationAgent", text: "Thank you. [natural-finish] Goodbye." },
    ]);
    expect(saved.warnings).toEqual([]);
    // Every operation reported its usage: the model's account of each response, the text and
    // audio of each synthesis, and the participant audio the opportunity forwarded.
    const [heard] = await records("natural-finish", "cascade.speech_input_usage");
    const heardMs = z.number().int().positive().parse(heard?.audioMs);
    const entry = (
      componentRole: string,
      provider: string,
      model: string,
      measure: string,
      unit: string,
      quantity: number,
    ) => ({ componentRole, provider, model, measure, unit, quantity });
    expect(saved.result).toEqual({
      ...saved.result,
      outcome: "completed",
      reason: "agent_requested_end",
      transcriptCompleteness: "complete",
      transcriptIncompleteReasons: [],
      runtimeUsage: {
        completeness: "complete",
        observations: [
          entry("language_model", "openai", "gpt-fake-closing", "input_text", "token", 61),
          entry("language_model", "openai", "gpt-fake-closing", "output_text", "token", 9),
          entry("language_model", "openai", "gpt-fake", "input_text", "token", 40),
          entry("language_model", "openai", "gpt-fake", "output_text", "token", 12),
          entry(
            "speech_to_text",
            "soniox",
            "stt-rt-v5",
            "input_audio",
            "audio_millisecond",
            heardMs,
          ),
          entry("text_to_speech", "soniox", "tts-rt-v2", "input_text", "character", 56 + 36),
          entry(
            "text_to_speech",
            "soniox",
            "tts-rt-v2",
            "output_audio",
            "audio_millisecond",
            800 + 1_200,
          ),
        ],
      },
    });
    // Cascade's diagnostics keep the account per output and per opportunity.
    expect(await records("natural-finish", "cascade.model_usage")).toEqual([
      expect.objectContaining({ model: "gpt-fake", inputTokens: 40, outputTokens: 12 }),
      expect.objectContaining({
        outputId: closing,
        model: "gpt-fake-closing",
        inputTokens: 61,
        outputTokens: 9,
      }),
    ]);
    // The model's completed output items, per output and in order.
    expect(
      (await records("natural-finish", "cascade.model_output_item")).map(
        ({ outputId, itemType, characters }) => ({ outputId, itemType, characters }),
      ),
    ).toEqual([
      { outputId: opening, itemType: "message", characters: 56 },
      { outputId: closing, itemType: "message", characters: 36 },
      { outputId: closing, itemType: "function_call", characters: null },
    ]);
    expect(await records("natural-finish", "cascade.speech_output_usage")).toEqual([
      expect.objectContaining({ characters: 56, audioMs: 800 }),
      expect.objectContaining({ outputId: closing, characters: 36, audioMs: 1_200 }),
    ]);
    expect(await records("natural-finish", "cascade.speech_input_usage")).toEqual([
      expect.objectContaining({ opportunityId: first.opportunityId }),
    ]);
  }, 60_000);

  it.each([
    ["settle-after-final", "The talks were|clear and calm", "The talks were clear and calm"],
    ["settle-at-closure", "|The talks were clear", "The talks were clear"],
  ])(
    "keeps the answer in progress at Stop with one speech-input finalization (%s)",
    async (scenario, heard, expected) => {
      const { received, socket } = await attachLive(scenario);
      const first = await firstOpportunity(received);
      sendAudio(socket, first.opportunityId, silence);
      sendAudio(socket, first.opportunityId, `cmd:hear:${scenario}:${heard}`);
      await settle();
      expect(kinds(received)).not.toContain("input.closed");
      await stop(scenario);
      const saved = await readResult(scenario);
      expect(saved.turns).toEqual([
        {
          role: "conversationAgent",
          text: `Welcome. [${scenario}] What worked well at the event?`,
        },
        { role: "participant", text: expected },
      ]);
      expect(saved.warnings).toEqual([]);
      expect(saved.result).toMatchObject({
        reason: "participant_stopped",
        transcriptCompleteness: "complete",
      });
      const [stream] = await recognition(scenario);
      expect(stream).toMatchObject({ finalizations: 1, audioChunks: 1 });
      expect(await records(scenario, "cascade.input_settled")).toEqual([
        expect.objectContaining({
          opportunityId: first.opportunityId,
          characters: expected.length,
        }),
      ]);
      expect(await records(scenario, "cascade.turn_admitted")).toEqual([]);
      expect((await fakes(scenario)).openai).toHaveLength(1);
    },
    60_000,
  );

  it("settles the answer in progress when the page closes its attachment once Runtime announced the end", async () => {
    const runId = "settle-on-detach";
    const { received, socket } = await attachLive(runId);
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, `cmd:hear:${runId}:The talks|were clear`);
    await settle();
    // The Lab page sends its Stop with the attachment open and closes it once Runtime announced
    // the end, while the answer may still be settling.
    expect((await post(runId, "/complete", { endReason: "participant_stopped" })).ok).toBe(true);
    await expect.poll(async () => (await readState(runId)).phase).not.toBe("live");
    socket.close(1000, "participation_ended");
    await expect
      .poll(async () => readState(runId), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "participant_stopped" } });
    const saved = await readResult(runId);
    expect(saved.turns.at(-1)).toEqual({ role: "participant", text: "The talks were clear" });
    expect(saved.result).toMatchObject({ outcome: "completed", reason: "participant_stopped" });
    expect(saved.warnings).toEqual([]);
    expect((await recognition(runId))[0]).toMatchObject({ finalizations: 1 });
    expect(await records(runId, "cascade.media_detached")).toHaveLength(1);
  }, 60_000);

  it("settles nothing when no one spoke before Stop", async () => {
    const { received, socket } = await attachLive("settle-silence");
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, "cmd:tag:settle-silence");
    sendAudio(socket, first.opportunityId, silence);
    await settle();
    await stop("settle-silence");
    const saved = await readResult("settle-silence");
    expect(saved.turns.map(({ role }) => role)).toEqual(["conversationAgent"]);
    expect(saved.warnings).toEqual([]);
    expect(await records("settle-silence", "cascade.input_settled")).toEqual([
      expect.objectContaining({ itemId: null, characters: 0 }),
    ]);
  }, 60_000);
});

/** The Run's controller state: its deadline and its completion, once it ended. */
const endedSchema = z.object({
  state: z.object({
    phase: z.string(),
    deadlineAt: z.number().optional(),
    completion: z
      .object({ endReason: z.string(), endingStartedAt: z.number(), warnings: z.array(z.string()) })
      .nullable()
      .optional(),
  }),
});
async function readEnded(runId: string) {
  return endedSchema.parse(await (await request(runId, "/state")).json()).state;
}

/** Waits until the Run ended with the given reason, running its alarm as the platform would. */
async function endedWith(runId: string, endReason: string) {
  await expect
    .poll(
      async () => {
        await request(runId, "/run-alarm");
        return readState(runId);
      },
      { timeout: 30_000, interval: 500 },
    )
    .toMatchObject({ phase: "ended", completion: { endReason } });
}

/** The output messages the browser received for one output, in order. */
function outputMessages(received: readonly Received[], outputId: string | undefined) {
  return received.flatMap(({ message }) =>
    "outputId" in message && message.outputId === outputId ? [message.type] : [],
  );
}

/** Answers the opening with one turn, then waits for the closing output to stream audio. */
async function answerUntilClosingPlays(scenario: string, chunks: number) {
  const { received, socket } = await attachLive(scenario);
  const first = await firstOpportunity(received);
  sendAudio(socket, first.opportunityId, `cmd:say:${scenario}:The talks were clear.`);
  await expect.poll(() => outputIds(received).length, { timeout: 15_000 }).toBe(2);
  const [, closing] = outputIds(received);
  await expect
    .poll(() => outputMessages(received, closing).filter((type) => type === "output.audio"), {
      timeout: 15_000,
    })
    .toHaveLength(chunks);
  return { received, socket, closing };
}

describe("Cascade Original's Stop, expiry and failures", () => {
  it.each([
    ["stop-finishing", false],
    ["stop-finishing-detached", true],
  ])(
    "keeps the reason of an admitted finish when Stop cuts its closing short (%s)",
    async (scenario, detached) => {
      const { received, socket, closing } = await answerUntilClosingPlays(scenario, 3);
      const stoppedAt = Date.now();
      expect((await post(scenario, "/complete", { endReason: "participant_stopped" })).ok).toBe(
        true,
      );
      // The Lab page closes its attachment once Runtime announced the end. Input closed at the
      // finish with nothing to settle, so Ending owes no answer and may already have ended; the
      // close changes nothing. A close while an answer still settles is the case above.
      if (detached) {
        await expect.poll(async () => (await readState(scenario)).phase).not.toBe("live");
        socket.close(1000, "participation_ended");
      }
      await expect
        .poll(async () => readState(scenario), { timeout: 20_000 })
        .toMatchObject({ phase: "ended", completion: { endReason: "agent_requested_end" } });
      // The closing is cancelled at once: its synthesis stops, and the browser clears it and
      // receives nothing more of it.
      expect((await fakes(scenario)).sonioxCancelledAt).toBeDefined();
      expect(outputMessages(received, closing).at(-1)).toBe("output.cancelled");
      const cancelledAt = received.find(
        ({ message }) => message.type === "output.cancelled" && message.outputId === closing,
      )?.at;
      expect((cancelledAt ?? Infinity) - stoppedAt).toBeLessThan(1_000);
      const saved = await readResult(scenario);
      expect(saved.result).toMatchObject({ outcome: "completed", reason: "agent_requested_end" });
      // The closing's text was submitted with the finish, so it stays the interviewer's turn.
      expect(saved.turns.at(-1)).toEqual({
        role: "conversationAgent",
        text: `Thank you. [${scenario}] Goodbye.`,
      });
      expect(saved.warnings).toEqual([]);
    },
    60_000,
  );

  it("ends the Run as interrupted at once when its media is lost during the closing", async () => {
    // Lost three seconds into the closing, while the Run is still Live after the finish.
    const { socket } = await answerUntilClosingPlays("closing-media-lost", 20);
    const detachedAt = Date.now();
    socket.close(4000, "network_lost");
    await endedWith("closing-media-lost", "agent_requested_end");
    const ended = await readEnded("closing-media-lost");
    expect(ended.completion?.endingStartedAt ?? Infinity).toBeLessThan(detachedAt + 2_000);
    // The admitted finish keeps its reason; the media failure makes the outcome interrupted.
    expect((await readResult("closing-media-lost")).result.outcome).toBe("interrupted");
    expect(await records("closing-media-lost", "runtime.live_degraded")).toEqual([
      expect.objectContaining({ errorText: "cascade_media_detached" }),
    ]);
  }, 60_000);

  it("gives the answer in progress one final settlement when the interview expires", async () => {
    const { received, socket } = await attachLive("expiry-answer", {
      interviewingDurationMs: 4_000,
    });
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, "cmd:hear:expiry-answer:The talks were|clear and calm");
    await expect
      .poll(async () => readState("expiry-answer"), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "timebox_reached" } });
    const saved = await readResult("expiry-answer");
    expect(saved.turns).toEqual([
      {
        role: "conversationAgent",
        text: "Welcome. [expiry-answer] What worked well at the event?",
      },
      { role: "participant", text: "The talks were clear and calm" },
    ]);
    expect(saved.result).toMatchObject({
      outcome: "completed",
      reason: "timebox_reached",
      transcriptCompleteness: "complete",
    });
    expect(saved.warnings).toEqual([]);
    expect((await recognition("expiry-answer"))[0]).toMatchObject({ finalizations: 1 });
    // Nothing follows the expiry: no further listening, turn or model request.
    expect(opportunities(received)).toHaveLength(1);
    expect((await fakes("expiry-answer")).openai).toHaveLength(1);
  }, 60_000);

  it("ends the Run as interrupted at once when its media is lost", async () => {
    const { received, socket } = await attachLive("media-lost");
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, "cmd:hear:media-lost:The talks|were clear");
    await settle();
    const detachedAt = Date.now();
    socket.close(4000, "network_lost");
    await endedWith("media-lost", "runtime_failed");
    const ended = await readEnded("media-lost");
    // The close is a failure at once: no Stop is awaited.
    expect(ended.completion?.endingStartedAt ?? Infinity).toBeLessThan(detachedAt + 2_000);
    const saved = await readResult("media-lost");
    expect(saved.result.outcome).toBe("interrupted");
    // The answer in progress at the close is not settled: no Ending's final input awaits it.
    expect(saved.turns.map(({ role }) => role)).toEqual(["conversationAgent"]);
    expect((await recognition("media-lost"))[0]).toMatchObject({ finalizations: 0 });
    expect(await records("media-lost", "cascade.media_detached")).toEqual([
      expect.objectContaining({ reason: "browser_closed" }),
    ]);
    expect((await fakes("media-lost")).openai).toHaveLength(1);
  }, 60_000);

  it("publishes an interrupted outcome when the closing's synthesis fails during finishing", async () => {
    const { received, closing } = await answerUntilClosingPlays("finishing-failure", 2);
    // The admitted finish keeps its reason; the failure makes the outcome interrupted.
    await expect
      .poll(async () => readState("finishing-failure"), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "agent_requested_end" } });
    expect(outputMessages(received, closing).at(-1)).toBe("output.failed");
    const saved = await readResult("finishing-failure");
    expect(saved.result.outcome).toBe("interrupted");
    expect(await records("finishing-failure", "cascade.output_failed")).toEqual([
      expect.objectContaining({ outputId: closing, code: "soniox_internal_error" }),
    ]);
  }, 60_000);

  it("keeps Stop's reason and records the failure when the final settlement fails", async () => {
    const { received, socket } = await attachLive("settle-failure");
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, "cmd:hear:settle-failure:The talks|were clear");
    await settle();
    await stop("settle-failure");
    const saved = await readResult("settle-failure");
    expect(saved.result).toMatchObject({ outcome: "completed", reason: "participant_stopped" });
    expect(saved.warnings).toContain("runtime_failed_during_finalization");
    // Only the observed final text is kept; the unsettled rest is never invented.
    expect(saved.turns.at(-1)).toEqual({ role: "participant", text: "The talks" });
    expect(await records("settle-failure", "cascade.input_failed")).toEqual([
      expect.objectContaining({ code: "soniox_internal_error" }),
    ]);
  }, 60_000);

  it("stops synthesis at once when the model response fails and keeps its submitted text", async () => {
    const received = await goLive("model-failure");
    await expect
      .poll(async () => readState("model-failure"), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "runtime_failed" } });
    const seen = await fakes("model-failure");
    // Synthesis was cancelled before its text ended: the failed response is never finished.
    expect(seen.soniox.at(-1)).toMatchObject({ cancel: true });
    expect(seen.soniox).not.toContainEqual(expect.objectContaining({ text_end: true }));
    expect(await records("model-failure", "cascade.output_synthesized")).toEqual([]);
    expect(kinds(received)).not.toContain("output.ended");
    const saved = await readResult("model-failure");
    expect(saved.result.outcome).toBe("interrupted");
    expect(saved.turns).toEqual([
      {
        role: "conversationAgent",
        text: "Welcome. [model-failure] What worked well at the event?",
      },
    ]);
  }, 60_000);

  it("starts no provider work for media readiness reported after Stop", async () => {
    await attachLive("stop-before-ready", { mediaReady: false });
    await stop("stop-before-ready");
    expect((await post("stop-before-ready", "/media-ready", {})).status).toBe(200);
    await settle();
    const all = fakesSchema.parse(
      await (await platform.dispatchFetch("https://probe.test/fakes")).json(),
    );
    expect(all["stop-before-ready"]).toBeUndefined();
  }, 60_000);

  it.each([
    ["restart-before-opening", false],
    ["restart-after-opening", true],
  ])(
    "ends the Run as interrupted after a Runtime restart without repeating work (%s)",
    async (scenario, opened) => {
      const { received } = await attachLive(scenario, { mediaReady: opened });
      if (opened) await firstOpportunity(received);
      const before = await readEnded(scenario);
      const openingRequests = opened ? (await fakes(scenario)).openai.length : 0;
      // A new platform is a new Runtime instance over the same Durable Object storage.
      await platform.dispose();
      platform = createPlatform();
      // The page may still report readiness; the restarted Runtime has no media to open.
      if (!opened) expect((await post(scenario, "/media-ready", {})).status).toBe(200);
      await endedWith(scenario, "runtime_failed");
      // The failure ended the Run before the persisted deadline; nothing renewed it.
      expect((await readEnded(scenario)).completion?.endingStartedAt).toBeLessThan(
        before.deadlineAt ?? 0,
      );
      // No model request or synthesis is repeated.
      const all = fakesSchema.parse(
        await (await platform.dispatchFetch("https://probe.test/fakes")).json(),
      );
      expect(all[scenario]).toBeUndefined();
      expect(openingRequests).toBe(opened ? 1 : 0);
      // Runtime's own recovery or the session's report of its lost session ends the Run; the
      // session reports its loss at most once.
      const lost = await records(scenario, "cascade.session_lost");
      expect(lost.length).toBeLessThanOrEqual(1);
      // Before the opening, readiness finds the session gone and reports it.
      if (!opened) expect(lost).toHaveLength(1);
      const saved = await readResult(scenario);
      expect(saved.result.outcome).toBe("interrupted");
      // Usage the lost session might still have reported is unknown: the usage is incomplete.
      expect(saved.result.runtimeUsage.completeness).toBe("incomplete");
      // The opening's text, submitted before the restart, is still eligible evidence.
      expect(saved.turns).toEqual(
        opened
          ? [
              {
                role: "conversationAgent",
                text: `Welcome. [${scenario}] What worked well at the event?`,
              },
            ]
          : [],
      );
    },
    90_000,
  );
});

describe("Cascade's provider steps that never complete", () => {
  /** Asks the fake endpoints to hold the next connection of a provider unanswered. */
  async function stallNext(endpoint: "soniox" | "soniox-stt") {
    const url = `https://probe.test/fakes/stall-next-${endpoint}`;
    expect((await platform.dispatchFetch(url)).status).toBe(204);
  }
  /** The held connections whose caller abandoned them, by URL. */
  async function abandoned() {
    const response = await platform.dispatchFetch("https://probe.test/fakes/abandoned");
    return z.array(z.string()).parse(await response.json());
  }
  /** Waits, while the page reports its presence, until the Run ended. */
  async function endedPresent(runId: string) {
    const until = Date.now() + 30_000;
    while ((await readState(runId)).phase !== "ended" && Date.now() < until)
      await waitPresent(runId, 1_000);
    return readState(runId);
  }

  it.each([
    ["tts-connection-stall", 10_000, "soniox_connection_timeout"],
    ["model-stall", 15_000, "openai_response_start_timeout"],
    ["tts-silent", 10_000, "soniox_audio_timeout"],
  ])(
    "fails the output at the step's limit and ends the Run as interrupted (%s)",
    async (scenario, limitMs, code) => {
      if (scenario === "tts-connection-stall") await stallNext("soniox");
      const received = await goLive(scenario);
      const startedAt = Date.now();
      expect(await endedPresent(scenario)).toMatchObject({
        phase: "ended",
        completion: { endReason: "runtime_failed" },
      });
      const failed = received.find(({ message }) => message.type === "output.failed");
      expect(failed?.message).toMatchObject({ type: "output.failed", code });
      // The failure came at the limit, not before it.
      expect((failed?.at ?? 0) - startedAt).toBeGreaterThanOrEqual(limitMs - 500);
      expect((failed?.at ?? Infinity) - startedAt).toBeLessThan(limitMs + 3_000);
      expect(await records(scenario, "cascade.output_failed")).toEqual([
        expect.objectContaining({ code }),
      ]);
      expect((await readResult(scenario)).result.outcome).toBe("interrupted");
      // The stalled response is abandoned at the provider too: its request is aborted.
      if (scenario === "model-stall")
        expect((await fakes(scenario)).openaiCancelledAt).toBeDefined();
      if (scenario === "tts-connection-stall")
        await expect.poll(abandoned).toContain("https://tts-rt.soniox.com/tts-websocket");
    },
    60_000,
  );

  it("fails speech input at its connection's limit and ends the Run as interrupted", async () => {
    await stallNext("soniox-stt");
    const { received } = await attachLive("stt-connection-stall");
    await firstOpportunity(received);
    // Listening opened before speech input was requested: the Run is still Live before the limit.
    await waitPresent("stt-connection-stall", 9_000);
    expect((await readState("stt-connection-stall")).phase).toBe("live");
    expect(await endedPresent("stt-connection-stall")).toMatchObject({
      phase: "ended",
      completion: { endReason: "runtime_failed" },
    });
    expect(await records("stt-connection-stall", "cascade.input_failed")).toEqual([
      expect.objectContaining({ code: "soniox_connection_timeout" }),
    ]);
    expect((await readResult("stt-connection-stall")).result.outcome).toBe("interrupted");
    // The connection request is abandoned at the provider too.
    await expect.poll(abandoned).toContain("https://stt-rt.soniox.com/transcribe-websocket");
  }, 60_000);
});

describe("Cascade speech output on Gradium TTS", () => {
  const gradiumSpeechOutput = { speechOutput: { provider: "gradium" } } as const;
  const spoken = (scenario: string) => `Welcome. [${scenario}] What worked well at the event?`;
  const gradiumSchema = z.array(
    z.object({
      scenario: z.string().nullable(),
      apiKey: z.string().nullable(),
      received: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
      audio: z.array(z.string()),
      endSentAt: z.number().nullable(),
      closedAt: z.number().nullable(),
    }),
  );
  /** The scenario's one Gradium connection, as the fake endpoint recorded it. */
  async function gradiumConnection(scenario: string) {
    const response = await platform.dispatchFetch("https://probe.test/gradium");
    const connections = gradiumSchema
      .parse(await response.json())
      .filter((connection) => connection.scenario === scenario);
    expect(connections).toHaveLength(1);
    const [connection] = connections;
    if (connection === undefined) throw new Error(`No Gradium connection for ${scenario}`);
    return connection;
  }
  const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const joined = (chunks: readonly Uint8Array[]) => {
    const all = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    return all;
  };
  /** Runs the scenario on Gradium until the Run ends, reporting the page's presence. */
  async function failedRun(scenario: string, prepare: string | undefined) {
    if (prepare !== undefined)
      expect((await platform.dispatchFetch(`https://probe.test/fakes/${prepare}`)).status).toBe(
        204,
      );
    const { received } = await attachLive(scenario, { executionSettings: gradiumSpeechOutput });
    const startedAt = Date.now();
    const until = Date.now() + 30_000;
    while ((await readState(scenario)).phase !== "ended" && Date.now() < until)
      await waitPresent(scenario, 1_000);
    expect(await readState(scenario)).toMatchObject({
      phase: "ended",
      completion: { endReason: "runtime_failed" },
    });
    const failed = received.find(({ message }) => message.type === "output.failed");
    return { startedAt, failed };
  }

  it("sets up Cascade's format and voice, sends whole words, then streams audio in whole samples until Gradium's end", async () => {
    const scenario = "gradium-speaks";
    const { received } = await attachLive(scenario, { executionSettings: gradiumSpeechOutput });
    await expect
      .poll(() => kinds(received).includes("output.ended"), { timeout: 15_000 })
      .toBe(true);
    const connection = await gradiumConnection(scenario);
    expect(connection.apiKey).toBe("fake-gradium");
    const [setup, ...rest] = connection.received;
    expect(setup).toEqual({
      type: "setup",
      model_name: "default",
      voice_id: "vjFyp2BcCyTlUmYb",
      output_format: "pcm_24000",
    });
    // The model's deltas split words, and Gradium joins its text messages with a space: the
    // adapter sends whole words, which joined with single spaces are the text unchanged, and
    // then the end of the text.
    expect(rest.at(-1)).toEqual({ type: "end_of_stream" });
    const textMessages = rest.slice(0, -1);
    expect(new Set(textMessages.map(({ type }) => type))).toEqual(new Set(["text"]));
    const texts = textMessages.map(({ text }) => text ?? "");
    expect(texts.length).toBeGreaterThan(1);
    expect(texts.join(" ")).toBe(spoken(scenario));
    for (const text of texts) expect(text).toBe(text.trim());

    // Every chunk Gradium sent has an odd length; the browser receives the same bytes in order,
    // in whole samples, and the output's end after Gradium's end_of_stream.
    const audio = received.flatMap(({ message }) =>
      message.type === "output.audio" ? [message] : [],
    );
    expect(audio.map(({ sequence }) => sequence)).toEqual(audio.map((_, index) => index));
    const delivered = audio.map(({ audio: chunk }) => bytesOf(chunk));
    for (const chunk of delivered) expect(chunk.length % 2).toBe(0);
    const sent = joined(connection.audio.map(bytesOf));
    expect(sent.length).toBe(4_800 * connection.audio.length);
    expect(joined(delivered)).toEqual(sent);
    const ended = received.find(({ message }) => message.type === "output.ended");
    expect(ended?.at).toBeGreaterThanOrEqual(connection.endSentAt ?? Infinity);
    expect((await readState(scenario)).settingsSummary?.speechOutput).toEqual({
      provider: "gradium",
      model: "default",
      voice: "Everly",
    });

    await stop(scenario);
    // Gradium reports no usage: Cascade measures the characters it gave and the audio it got.
    const { result } = await readResult(scenario);
    expect(
      result.runtimeUsage.observations.filter(
        (entry) =>
          z.object({ componentRole: z.string() }).parse(entry).componentRole === "text_to_speech",
      ),
    ).toEqual([
      {
        componentRole: "text_to_speech",
        provider: "gradium",
        model: "default",
        measure: "input_text",
        unit: "character",
        quantity: spoken(scenario).length,
      },
      {
        componentRole: "text_to_speech",
        provider: "gradium",
        model: "default",
        measure: "output_audio",
        unit: "audio_millisecond",
        quantity: (sent.length / 2 / 24_000) * 1_000,
      },
    ]);
    expect(result.runtimeUsage.completeness).toBe("complete");
  }, 60_000);

  it("closes the connection when Stop interrupts synthesis, and delivers nothing after it", async () => {
    const scenario = "gradium-stop";
    const { received } = await attachLive(scenario, { executionSettings: gradiumSpeechOutput });
    await expect
      .poll(() => received.filter(({ message }) => message.type === "output.audio").length, {
        timeout: 15_000,
      })
      .toBeGreaterThan(3);
    await stop(scenario);
    // The text had ended when Stop came. Gradium has no cancel message: the adapter sends
    // nothing more and closes the connection.
    await expect
      .poll(async () => (await gradiumConnection(scenario)).closedAt, { timeout: 10_000 })
      .not.toBeNull();
    expect(new Set((await gradiumConnection(scenario)).received.map(({ type }) => type))).toEqual(
      new Set(["setup", "text", "end_of_stream"]),
    );
    const cancelled = kinds(received).indexOf("output.cancelled");
    expect(cancelled).toBeGreaterThan(0);
    await settle();
    expect(received.slice(cancelled + 1)).toEqual([]);
    expect(kinds(received)).not.toContain("output.ended");
  }, 60_000);

  it("fails the output with Gradium's error code and ends the Run as a Runtime failure", async () => {
    const { failed } = await failedRun("gradium-error", undefined);
    expect(failed?.message).toMatchObject({ type: "output.failed", code: "gradium_error_1011" });
    expect(await records("gradium-error", "cascade.output_failed")).toEqual([
      expect.objectContaining({ code: "gradium_error_1011" }),
    ]);
    expect((await readResult("gradium-error")).result.outcome).toBe("interrupted");
  }, 60_000);

  it.each([
    ["gradium-connection-stall", "stall-next-gradium", "gradium_connection_timeout"],
    ["gradium-ready-stall", "hold-next-gradium-ready", "gradium_connection_timeout"],
    ["gradium-silent", undefined, "gradium_audio_timeout"],
  ])(
    "fails the output at its step's 10 s limit (%s)",
    async (scenario, prepare, code) => {
      const { failed, startedAt } = await failedRun(scenario, prepare);
      expect(failed?.message).toMatchObject({ type: "output.failed", code });
      // The failure came at the limit, not before it.
      expect((failed?.at ?? 0) - startedAt).toBeGreaterThanOrEqual(10_000 - 500);
      expect((failed?.at ?? Infinity) - startedAt).toBeLessThan(10_000 + 3_000);
      expect((await readResult(scenario)).result.outcome).toBe("interrupted");
      // The stalled connection request is abandoned at the provider too.
      if (prepare === "stall-next-gradium") {
        const response = await platform.dispatchFetch("https://probe.test/fakes/abandoned");
        expect(z.array(z.string()).parse(await response.json())).toContain(
          "https://api.gradium.ai/api/speech/tts",
        );
      }
    },
    60_000,
  );
});

describe("Cascade speech input on Gradium STT", () => {
  const gradiumSpeechInput = { speechInput: { provider: "gradium" } } as const;
  const gradiumRecognitionSchema = z.array(
    z.object({
      scenario: z.string().nullable(),
      apiKey: z.string().nullable(),
      heldReady: z.boolean(),
      received: z.array(z.looseObject({ type: z.string() })),
      audioBytes: z.number(),
      stepsSent: z.number(),
      flushes: z.array(z.object({ flushId: z.number(), stepsBefore: z.number() })),
      closed: z.boolean(),
    }),
  );
  /** Every Gradium STT connection, as the fake endpoint recorded it. */
  async function allGradiumRecognition() {
    const response = await platform.dispatchFetch("https://probe.test/gradium-stt");
    return gradiumRecognitionSchema.parse(await response.json());
  }
  /** The scenario's one Gradium STT connection. */
  async function gradiumRecognition(scenario: string) {
    const connections = (await allGradiumRecognition()).filter(
      (connection) => connection.scenario === scenario,
    );
    expect(connections).toHaveLength(1);
    const [connection] = connections;
    if (connection === undefined) throw new Error(`No Gradium STT connection for ${scenario}`);
    return connection;
  }
  /** Sends participant audio and returns how many bytes it was. */
  function speak(
    socket: { send(data: string): void },
    opportunityId: string,
    audio: Uint8Array | string,
  ) {
    sendAudio(socket, opportunityId, audio);
    return typeof audio === "string" ? new TextEncoder().encode(audio).length : audio.length;
  }

  it("sets up Cascade's format, joins words with a space, and ends the turn at the flush its rule sent, after the flushed text", async () => {
    const scenario = "gradium-stt-turn";
    const { received, socket } = await attachLive(scenario, {
      executionSettings: gradiumSpeechInput,
    });
    const first = await firstOpportunity(received);
    const say = (audio: Uint8Array | string) => speak(socket, first.opportunityId, audio);
    let audioBytes = 0;
    // Silence: the probability of having stopped is high, but no text is pending.
    audioBytes += say(silence);
    audioBytes += say(`cmd:steps:${scenario}:0.9,0.9,0.9,0.9`);
    // Speech, then a pause whose last step falls back to the threshold: the count restarts.
    audioBytes += say(`cmd:steps:${scenario}:0.2,0.1`);
    audioBytes += say(`cmd:words:${scenario}:The talks were`);
    audioBytes += say(`cmd:steps:${scenario}:0.6,0.6,0.5`);
    audioBytes += say(silence);
    await settle();
    expect((await gradiumRecognition(scenario)).flushes).toEqual([]);
    expect(kinds(received)).not.toContain("input.closed");
    // Three steps above the threshold: the adapter flushes, and the flush settles a last word.
    audioBytes += say(`cmd:tail:${scenario}:clear`);
    audioBytes += say(`cmd:steps:${scenario}:0.6,0.6,0.6,0.6`);
    await expect.poll(() => opportunities(received).length, { timeout: 15_000 }).toBe(2);

    const connection = await gradiumRecognition(scenario);
    expect(connection.apiKey).toBe("fake-gradium");
    expect(connection.received[0]).toEqual({
      type: "setup",
      model_name: "default",
      input_format: "pcm_16000",
      json_config: { language: "en", delay_in_frames: 10 },
    });
    // One flush, sent at the third step above the threshold after the reset, then the stream's
    // end once the turn closed it; nothing else but audio was sent: no keepalive.
    expect(connection.flushes.map(({ stepsBefore }) => stepsBefore)).toEqual([4 + 2 + 3 + 3]);
    expect(connection.received.slice(1).map(({ type }) => type)).toEqual([
      "flush",
      "end_of_stream",
    ]);
    // Every byte of the participant's audio reached Gradium, as base64 audio messages.
    expect(connection.audioBytes).toBe(audioBytes);
    // The admitted turn holds the words joined with spaces, and the word Gradium sent between
    // the flush and its flushed: the turn ended at the flushed.
    const seen = await fakes(scenario);
    expect(z.object({ input: z.json() }).parse(seen.openai[1]?.body).input).toEqual([
      { role: "developer", content: promptFor(scenario) },
      { role: "assistant", content: `Welcome. [${scenario}] What worked well at the event?` },
      { role: "user", content: "The talks were clear" },
    ]);
    expect(await records(scenario, "cascade.turn_admitted")).toHaveLength(1);
    expect((await readState(scenario)).settingsSummary?.speechInput).toEqual({
      provider: "gradium",
      model: "default",
      delayInFrames: 10,
      turnHorizon: 2,
      turnThreshold: 0.5,
      turnSteps: 3,
    });

    await stop(scenario);
    // Gradium reports no usage: Cascade measures the participant audio it forwarded.
    const { result } = await readResult(scenario);
    expect(
      result.runtimeUsage.observations.filter(
        (entry) =>
          z.object({ componentRole: z.string() }).parse(entry).componentRole === "speech_to_text",
      ),
    ).toEqual([
      {
        componentRole: "speech_to_text",
        provider: "gradium",
        model: "default",
        measure: "input_audio",
        unit: "audio_millisecond",
        quantity: Math.round((audioBytes / 2 / 16_000) * 1_000),
      },
    ]);
    expect(result.runtimeUsage.completeness).toBe("complete");
  }, 60_000);

  it("applies the turn rule a Start gives, and ends a short answer whose words came after the pause was counted", async () => {
    const scenario = "gradium-stt-given";
    // The fake reports the 3 s horizon as the complement of the 2 s one: a listed probability p
    // is 1 - p at this rule's horizon.
    const given = {
      provider: "gradium",
      delayInFrames: 7,
      turnHorizon: 3,
      turnThreshold: 0.7,
      turnSteps: 2,
    } as const;
    const { received, socket } = await attachLive(scenario, {
      executionSettings: { speechInput: given },
    });
    const first = await firstOpportunity(received);
    // A short answer: Gradium commits its word after the pause has already exceeded the
    // threshold on more than the rule's steps. The next step above the threshold ends the turn.
    sendAudio(socket, first.opportunityId, `cmd:steps:${scenario}:0.1,0.1,0.1`);
    sendAudio(socket, first.opportunityId, `cmd:words:${scenario}:Yes`);
    sendAudio(socket, first.opportunityId, `cmd:steps:${scenario}:0.1`);
    await expect.poll(() => opportunities(received).length, { timeout: 15_000 }).toBe(2);
    const second = opportunities(received)[1];
    if (second === undefined) throw new Error("Missing the second listening opportunity");
    // A step at the threshold does not count; two above it end the turn.
    const again = `${scenario}-again`;
    sendAudio(socket, second.opportunityId, `cmd:words:${again}:Mostly the talks`);
    sendAudio(socket, second.opportunityId, `cmd:steps:${again}:0.3,0.2,0.2`);
    await expect.poll(() => opportunities(received).length, { timeout: 15_000 }).toBe(3);

    for (const [name, stepsBefore] of [
      [scenario, 4],
      [again, 3],
    ] as const) {
      const connection = await gradiumRecognition(name);
      expect(connection.received[0]).toEqual({
        type: "setup",
        model_name: "default",
        input_format: "pcm_16000",
        json_config: { language: "en", delay_in_frames: 7 },
      });
      expect(connection.flushes.map((flush) => flush.stepsBefore)).toEqual([stepsBefore]);
    }
    expect((await readState(scenario)).settingsSummary?.speechInput).toEqual({
      ...given,
      model: "default",
    });
    await stop(scenario);
    expect((await readResult(scenario)).turns.map(({ role, text }) => [role, text])).toEqual([
      ["conversationAgent", `Welcome. [${scenario}] What worked well at the event?`],
      ["participant", "Yes"],
      ["conversationAgent", `Welcome. [${scenario}] What worked well at the event?`],
      ["participant", "Mostly the talks"],
      ["conversationAgent", `Welcome. [${scenario}] What worked well at the event?`],
    ]);
  }, 60_000);

  it("settles the answer in progress on its own flush when Stop closes input", async () => {
    const scenario = "gradium-stt-settle";
    const { received, socket } = await attachLive(scenario, {
      executionSettings: gradiumSpeechInput,
    });
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, `cmd:words:${scenario}:The talks were`);
    sendAudio(socket, first.opportunityId, `cmd:tail:${scenario}:clear and calm`);
    await settle();
    await stop(scenario);
    const saved = await readResult(scenario);
    expect(saved.turns).toEqual([
      { role: "conversationAgent", text: `Welcome. [${scenario}] What worked well at the event?` },
      { role: "participant", text: "The talks were clear and calm" },
    ]);
    expect(saved.result).toMatchObject({ transcriptCompleteness: "complete" });
    expect(await records(scenario, "cascade.input_settled")).toEqual([
      expect.objectContaining({ characters: "The talks were clear and calm".length }),
    ]);
    // Only finalization flushed: the turn rule saw no step. The stream then ended and closed.
    expect(
      (await gradiumRecognition(scenario)).flushes.map(({ stepsBefore }) => stepsBefore),
    ).toEqual([0]);
    await expect
      .poll(async () => (await gradiumRecognition(scenario)).closed, { timeout: 10_000 })
      .toBe(true);
    expect((await gradiumRecognition(scenario)).received.map(({ type }) => type)).toEqual([
      "setup",
      "flush",
      "end_of_stream",
    ]);
  }, 60_000);

  it("waits through silence of any length without a keepalive and admits no turn", async () => {
    const scenario = "gradium-stt-silence";
    const { received, socket } = await attachLive(scenario, {
      executionSettings: gradiumSpeechInput,
    });
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, `cmd:tag:${scenario}`);
    // No audio, then ordinary silence whose steps report the speaker stopped: together longer
    // than every provider step's time limit.
    await waitPresent(scenario, 16_000);
    for (let index = 0; index < 10; index += 1) sendAudio(socket, first.opportunityId, silence);
    sendAudio(socket, first.opportunityId, `cmd:steps:${scenario}:0.9,0.9,0.9,0.9,0.9`);
    await settle();
    const connection = await gradiumRecognition(scenario);
    expect(connection.closed).toBe(false);
    expect(connection.stepsSent).toBe(5);
    expect(connection.received.map(({ type }) => type)).toEqual(["setup"]);
    expect(kinds(received)).not.toContain("input.closed");
    expect((await readState(scenario)).phase).toBe("live");
    expect((await fakes(scenario)).openai).toHaveLength(1);
    await stop(scenario);
  }, 60_000);

  it.each([
    ["gradium-stt-error", "fail", "gradium_error_1011"],
    ["gradium-stt-dropped", "drop", "gradium_connection_closed"],
    ["gradium-stt-short-step", "short-step", "gradium_turn_horizon_missing"],
  ])(
    "ends the Run as a Runtime failure when Gradium fails the stream or its turn signal (%s)",
    async (scenario, verb, code) => {
      const { received, socket } = await attachLive(scenario, {
        executionSettings: gradiumSpeechInput,
      });
      const first = await firstOpportunity(received);
      sendAudio(socket, first.opportunityId, `cmd:words:${scenario}:The talks`);
      sendAudio(socket, first.opportunityId, `cmd:${verb}:${scenario}`);
      await expect
        .poll(async () => readState(scenario), { timeout: 20_000 })
        .toMatchObject({ phase: "ended", completion: { endReason: "runtime_failed" } });
      expect(await records(scenario, "cascade.input_failed")).toEqual([
        expect.objectContaining({ code }),
      ]);
      expect((await readResult(scenario)).result.outcome).toBe("interrupted");
    },
    60_000,
  );

  it("fails speech input when Gradium is not ready at the connection's limit", async () => {
    const scenario = "gradium-stt-ready-stall";
    expect(
      (await platform.dispatchFetch("https://probe.test/fakes/hold-next-gradium-stt-ready")).status,
    ).toBe(204);
    const { received } = await attachLive(scenario, { executionSettings: gradiumSpeechInput });
    await firstOpportunity(received);
    // Listening opened before speech input was requested: the Run is still Live before the limit.
    await waitPresent(scenario, 9_000);
    expect((await readState(scenario)).phase).toBe("live");
    const until = Date.now() + 30_000;
    while ((await readState(scenario)).phase !== "ended" && Date.now() < until)
      await waitPresent(scenario, 1_000);
    expect(await readState(scenario)).toMatchObject({
      phase: "ended",
      completion: { endReason: "runtime_failed" },
    });
    expect(await records(scenario, "cascade.input_failed")).toEqual([
      expect.objectContaining({ code: "gradium_connection_timeout" }),
    ]);
    expect((await readResult(scenario)).result.outcome).toBe("interrupted");
    // The connection that never became ready was set up, then closed.
    const held = (await allGradiumRecognition()).filter((connection) => connection.heldReady);
    expect(
      held.map(({ received: sent, closed }) => ({ sent: sent.map(({ type }) => type), closed })),
    ).toEqual([{ sent: ["setup", "end_of_stream"], closed: true }]);
  }, 60_000);
});

describe("Cascade's language model on Cerebras qwen", () => {
  const onCerebras = { languageModel: { provider: "cerebras" } } as const;
  const spoken = (scenario: string) => `Welcome. [${scenario}] What worked well at the event?`;
  const cerebrasSchema = z.record(
    z.string(),
    z.object({
      requests: z.array(
        z.object({
          authorization: z.string().nullable(),
          body: z.looseObject({ messages: z.array(z.json()) }),
          at: z.number(),
        }),
      ),
      cancelledAt: z.number().nullable(),
    }),
  );
  async function allCerebras() {
    const response = await platform.dispatchFetch("https://probe.test/cerebras");
    return cerebrasSchema.parse(await response.json());
  }
  /** What the fake Cerebras endpoint received for the scenario: no request is none. */
  async function cerebras(scenario: string) {
    return (await allCerebras())[scenario] ?? { requests: [], cancelledAt: null };
  }
  /** How many requests the fake Cerebras endpoint received, for any scenario. */
  async function cerebrasRequestCount() {
    return Object.values(await allCerebras()).reduce(
      (total, { requests }) => total + requests.length,
      0,
    );
  }
  /** Runs the scenario on Cerebras until the Run ends, reporting the page's presence. */
  async function failedRun(scenario: string) {
    const { received } = await attachLive(scenario, { executionSettings: onCerebras });
    const until = Date.now() + 40_000;
    while ((await readState(scenario)).phase !== "ended" && Date.now() < until)
      await waitPresent(scenario, 1_000);
    expect(await readState(scenario)).toMatchObject({
      phase: "ended",
      completion: { endReason: "runtime_failed" },
    });
    const failed = received.find(({ message }) => message.type === "output.failed");
    const [record] = await records(scenario, "cascade.output_failed");
    return { failed, record, seen: await cerebras(scenario) };
  }
  /** A Cascade record of one output, without the fields every such record carries. */
  const outputRecord = (record: Awaited<ReturnType<typeof records>>[number] | undefined) => {
    const { source: _source, provider: _provider, outputId: _outputId, ...rest } = record ?? {};
    return rest;
  };

  it("runs a Start without settings on Cerebras: sends the instructions, the opening's empty user message, tools, effort and cap, then speaks the answer and the closing with its finish", async () => {
    const scenario = "cerebras-speaks";
    const { received, socket } = await attachLive(scenario, {
      onDefaults: true,
      reasoningEffort: "low",
    });
    const first = await firstOpportunity(received);
    sendAudio(socket, first.opportunityId, `cmd:say:${scenario}:The talks were clear.`);
    await expect
      .poll(async () => readState(scenario), { timeout: 20_000 })
      .toMatchObject({ phase: "ended", completion: { endReason: "agent_requested_end" } });
    const [opening, closing] = outputIds(received);

    const { requests } = await cerebras(scenario);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.authorization).toBe("Bearer fake-cerebras");
    expect(requests[0]?.body).toEqual({
      model: "qwen-3.8-27b",
      stream: true,
      messages: [
        { role: "system", content: promptFor(scenario) },
        { role: "user", content: "" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "finish_interview",
            description: finishDescription,
            parameters: { type: "object", properties: {}, additionalProperties: false },
            strict: false,
          },
        },
      ],
      tool_choice: "auto",
      reasoning_effort: "low",
      max_completion_tokens: 1024,
    });
    // Once the participant spoke, the history follows the instructions with no empty message.
    expect(requests[1]?.body.messages).toEqual([
      { role: "system", content: promptFor(scenario) },
      { role: "assistant", content: spoken(scenario) },
      { role: "user", content: "The talks were clear." },
    ]);

    // The blank lines after reasoning reach neither speech output nor the transcript.
    const texts = (await fakes(scenario)).soniox.flatMap((message) =>
      typeof message === "object" && message !== null && "text" in message ? [message.text] : [],
    );
    expect(texts).toEqual([
      `Welcome. [${scenario}] `,
      "What worked ",
      "well at ",
      "the event?",
      "",
      `Thank you. [${scenario}] `,
      "Goodbye.",
      "",
    ]);
    const saved = await readResult(scenario);
    expect(saved.turns).toEqual([
      { role: "conversationAgent", text: spoken(scenario) },
      { role: "participant", text: "The talks were clear." },
      { role: "conversationAgent", text: `Thank you. [${scenario}] Goodbye.` },
    ]);
    // Output items derived from the stream, per output and in order.
    expect(
      (await records(scenario, "cascade.model_output_item")).map(
        ({ outputId, itemType, characters }) => ({ outputId, itemType, characters }),
      ),
    ).toEqual([
      { outputId: opening, itemType: "reasoning", characters: null },
      { outputId: opening, itemType: "message", characters: spoken(scenario).length },
      { outputId: closing, itemType: "reasoning", characters: null },
      { outputId: closing, itemType: "message", characters: 37 },
      { outputId: closing, itemType: "function_call", characters: null },
    ]);
    // Each response's usage account, naming the model that answered; Runtime sums the two.
    expect(
      (await records(scenario, "cascade.model_usage")).map(
        ({ outputId, model, inputTokens, outputTokens }) => ({
          outputId,
          model,
          inputTokens,
          outputTokens,
        }),
      ),
    ).toEqual([
      { outputId: opening, model: "qwen-fake", inputTokens: 40, outputTokens: 12 },
      { outputId: closing, model: "qwen-fake", inputTokens: 61, outputTokens: 9 },
    ]);
    const languageModel = z
      .array(z.looseObject({ componentRole: z.string() }))
      .parse(saved.result.runtimeUsage.observations)
      .filter(({ componentRole }) => componentRole === "language_model");
    const entry = { componentRole: "language_model", provider: "cerebras", model: "qwen-fake" };
    expect(languageModel).toEqual([
      { ...entry, measure: "input_text", unit: "token", quantity: 101 },
      { ...entry, measure: "output_text", unit: "token", quantity: 21 },
    ]);
    expect(saved.result.runtimeUsage.completeness).toBe("complete");
    expect((await readState(scenario)).settingsSummary).toMatchObject({
      languageModel: { provider: "cerebras", model: "qwen-3.8-27b" },
      reasoningEffort: "low",
    });
  }, 60_000);

  it.each([
    ["cerebras-length", "cerebras_response_incomplete:length"],
    ["cerebras-dropped", "cerebras_stream_closed"],
  ])(
    "fails the output and ends the Run as a Runtime failure on %s",
    async (scenario, code) => {
      const { failed, record, seen } = await failedRun(scenario);
      expect(failed?.message).toMatchObject({ type: "output.failed", code });
      expect(outputRecord(record)).toEqual({ code });
      expect(seen.requests).toHaveLength(1);
    },
    60_000,
  );

  it("fails at once on a quota refusal, naming it, with no retry", async () => {
    const { failed, record, seen } = await failedRun("cerebras-quota");
    expect(failed?.message).toMatchObject({ type: "output.failed", code: "cerebras_http_429" });
    expect(outputRecord(record)).toEqual({
      code: "cerebras_http_429",
      refusal: "token_quota_exceeded",
      attempts: 1,
    });
    expect(seen.requests).toHaveLength(1);
    expect(await records("cerebras-quota", "cascade.model_retry")).toEqual([]);
    await settle();
    expect((await cerebras("cerebras-quota")).requests).toHaveLength(1);
  }, 60_000);

  it("retries a capacity refusal after its wait and speaks the answer", async () => {
    const scenario = "cerebras-queue-once";
    const { received } = await attachLive(scenario, { executionSettings: onCerebras });
    await expect
      .poll(() => kinds(received).includes("output.ended"), { timeout: 15_000 })
      .toBe(true);
    expect(kinds(received)).not.toContain("output.failed");
    const [refused, answered] = (await cerebras(scenario)).requests;
    expect((answered?.at ?? 0) - (refused?.at ?? Infinity)).toBeGreaterThanOrEqual(500);
    expect(answered?.body).toEqual(refused?.body);
    expect(
      (await records(scenario, "cascade.model_retry")).map((record) => outputRecord(record)),
    ).toEqual([{ refusal: "queue_exceeded", attempt: 1, waitMs: 500 }]);
    await stop(scenario);
    expect((await readResult(scenario)).turns).toEqual([
      { role: "conversationAgent", text: spoken(scenario) },
    ]);
  }, 60_000);

  it("retries a capacity refusal four times after waits of 0.5, 1, 2 and 4 s, then fails naming it", async () => {
    const scenario = "cerebras-queue-always";
    const { failed, record, seen } = await failedRun(scenario);
    expect(failed?.message).toMatchObject({ type: "output.failed", code: "cerebras_http_429" });
    expect(outputRecord(record)).toEqual({
      code: "cerebras_http_429",
      refusal: "queue_exceeded",
      attempts: 5,
    });
    const at = seen.requests.map((request) => request.at);
    expect(at).toHaveLength(5);
    const gaps = at.slice(1).map((time, index) => time - (at[index] ?? time));
    [500, 1_000, 2_000, 4_000].forEach((wait, index) => {
      expect(gaps[index]).toBeGreaterThanOrEqual(wait);
      expect(gaps[index]).toBeLessThan(wait + 400);
    });
    expect(
      (await records(scenario, "cascade.model_retry")).map((retry) => outputRecord(retry)),
    ).toEqual(
      [500, 1_000, 2_000, 4_000].map((waitMs, index) => ({
        refusal: "queue_exceeded",
        attempt: index + 1,
        waitMs,
      })),
    );
    // The fifth refusal fails the output: no sixth request follows.
    expect(failed?.at ?? 0).toBeGreaterThanOrEqual(at[4] ?? Infinity);
    await settle();
    expect((await cerebras(scenario)).requests).toHaveLength(5);
  }, 60_000);

  it("fails as the capacity refusal when the answer-start limit comes before the retries end", async () => {
    // Each refusal takes 3 s: the fourth attempt is still unanswered at 15 s.
    const scenario = "cerebras-queue-slow";
    const { failed, record, seen } = await failedRun(scenario);
    expect(failed?.message).toMatchObject({ type: "output.failed", code: "cerebras_http_429" });
    expect(outputRecord(record)).toEqual({
      code: "cerebras_http_429",
      refusal: "queue_exceeded",
      attempts: 4,
    });
    const firstAt = seen.requests[0]?.at ?? 0;
    expect((failed?.at ?? 0) - firstAt).toBeGreaterThanOrEqual(15_000 - 500);
    expect((failed?.at ?? Infinity) - firstAt).toBeLessThan(15_000 + 3_000);
    expect(seen.requests).toHaveLength(4);
    // The attempt in flight is abandoned at the provider too.
    expect(seen.cancelledAt).not.toBeNull();
  }, 60_000);

  it("fails a response that has not started to answer at its 15 s limit and abandons it", async () => {
    const scenario = "cerebras-stall";
    const { failed, record, seen } = await failedRun(scenario);
    expect(failed?.message).toMatchObject({
      type: "output.failed",
      code: "cerebras_response_start_timeout",
    });
    expect(outputRecord(record)).toEqual({ code: "cerebras_response_start_timeout" });
    expect((failed?.at ?? 0) - (seen.requests[0]?.at ?? 0)).toBeGreaterThanOrEqual(15_000 - 500);
    expect(seen.cancelledAt).not.toBeNull();
  }, 60_000);

  it.each(["minimal", "xhigh"] as const)(
    "refuses effort %s before any provider request",
    async (reasoningEffort) => {
      const scenario = `cerebras-effort-${reasoningEffort}`;
      const response = await client.start(scenario, {
        selection: originalCascadeSelection,
        agentInput: createInterviewConversationInput(promptFor(scenario), finishDescription),
        executionSettings: onCerebras,
        reasoningEffort,
      });
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 400,
        body: {
          runId: scenario,
          exchangeId: `exchange-${scenario}`,
          acceptance: "not_accepted",
          error: "invalid_execution_settings",
        },
      });
      await settle();
      expect((await cerebras(scenario)).requests).toEqual([]);
    },
    30_000,
  );

  it("fails the first response of instructions that reference an OpenAI stored prompt, sending nothing", async () => {
    const scenario = "cerebras-stored-prompt";
    const requests = await cerebrasRequestCount();
    const literal = createInterviewConversationInput(promptFor(scenario), finishDescription);
    const run = {
      selection: originalCascadeSelection,
      agentInput: {
        ...literal,
        interviewing: {
          ...literal.interviewing,
          instructions: {
            kind: "provider_prompt" as const,
            reference: { id: "pmpt_fake" },
            supplementalText: "",
          },
        },
      },
      executionSettings: onCerebras,
    };
    const { received } = await client.goLive(scenario, run);
    await expect
      .poll(() => kinds(received).includes("output.failed"), { timeout: 15_000 })
      .toBe(true);
    expect(received.find(({ message }) => message.type === "output.failed")?.message).toMatchObject(
      { code: "cerebras_provider_prompt_unsupported" },
    );
    expect(await cerebrasRequestCount()).toBe(requests);
  }, 60_000);
});
