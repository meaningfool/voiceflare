# voiceflare

voiceflare runs short voice interviews on Cloudflare Workers. An AI interviewer talks with one
participant, follows an interview design within a time limit, ends the interview, and delivers a
transcript and a result. voiceflare has two parts: Runtime, the voice engine that carries out each
interview, and the Lab, a local page where you set up an interview, run it with your microphone and
read what it delivered.

voiceflare is a reference implementation, taken from [EventPulse](https://eventpulse.cc), which
runs the same engine. It has no deployment, no login and no product around it: everything runs on
your machine, and you are the participant.

This is a first version. The engine's core will be replaced in a later version.

## What you need

- Node 24 or later. The local commands run TypeScript files with Node directly.
- pnpm 10. `package.json` names the version; `corepack enable` provides it.
- A browser with a microphone, for interviews.
- Provider keys, for real interviews. Without them the Lab runs, but it cannot start an interview.

| Key                | Provider | Used by                                                                 |
| ------------------ | -------- | ----------------------------------------------------------------------- |
| `OPENAI_API_KEY`   | OpenAI   | Realtime. Cascade too, when a Run chooses OpenAI as its language model. |
| `SONIOX_API_KEY`   | Soniox   | Cascade's default speech input and speech output.                       |
| `GRADIUM_API_KEY`  | Gradium  | Cascade, when a Run chooses Gradium for speech input or output.         |
| `CEREBRAS_API_KEY` | Cerebras | Cascade's default language model.                                       |

A Realtime interview needs `OPENAI_API_KEY`. A Cascade interview always needs `SONIOX_API_KEY` and
`CEREBRAS_API_KEY`, plus the key of any other provider the Run chooses. Each interview calls the
providers with your keys, at your accounts' prices. No Cloudflare account is needed.

## Run the Lab

```bash
git clone https://github.com/meaningfool/voiceflare.git
cd voiceflare
pnpm install
pnpm dev
```

pnpm says that it ignored the build scripts of esbuild, sharp and workerd. voiceflare runs without
them, so there is nothing to approve.

`pnpm dev` first asks for each provider key it has not saved yet, in the order of the table above.
Type or paste a key, or press Enter to skip it; input is hidden. The keys are saved in `.dev.vars`,
which git ignores, and a skipped key is not asked for again. Runtime reads its keys only from
`.dev.vars`, not from your shell's environment.

Then `pnpm dev` prepares the Lab's local database, builds the Lab page and starts Runtime and the
Lab together. Along the way, Wrangler answers its own question about applying the migration, names
the Workers `eventpulse-lab` and `eventpulse-runtime`, and shows their bindings to each other as
`[not connected]` until both have started. These messages and the warnings around them are
expected. When `pnpm dev` prints `Lab: http://127.0.0.1:8795`, open that address. Ctrl-C in the
terminal stops both Workers. `pnpm dev --port <port>` uses another port.

`pnpm keys` changes the saved keys, and `pnpm keys SONIOX_API_KEY` changes only that one. Press
Enter to keep a key as it is, or type `-` to remove it. Restart `pnpm dev` to use the change.

The Lab's database and Runtime's state live in `.wrangler/`, and the built page in `dist/`; git
ignores both. To start again with an empty Lab, stop `pnpm dev` and delete `.wrangler/`. The keys
in `.dev.vars` stay.

## A first interview

The Lab's "Conversation and execution" list has six combinations: three interview designs, called
Conversations, each on two executions. The Conversations:

- **Original interview.** The interviewer follows a prompt from the Lab's prompt library, says its
  closing message and ends the interview.
- **Dedicated Goodbye.** The interviewer follows its instructions and ends the interview. A fixed
  closing sentence is then spoken.
- **Questions.** The interviewer asks one question at a time from a list, moves to the next when
  the participant has answered, and ends with the same fixed closing.

The executions:

- **Realtime.** OpenAI Realtime, one speech-to-speech model. Audio goes directly between your
  browser and OpenAI.
- **Cascade.** Speech-to-text, a text language model and text-to-speech, run by Runtime. Your
  browser streams audio to Runtime, and you and the interviewer take turns.

A combination whose keys are missing is disabled and names them, for example "Questions · Cascade
(missing SONIOX_API_KEY, CEREBRAS_API_KEY)". With the keys set:

1. Choose a combination. Its editor shows the texts the interview starts from, which you can
   change.
2. Press Start Interview and allow the microphone.
3. Talk with the interviewer. The interview ends when the interviewer finishes, when its time limit
   is reached, or when you press End Interview.
4. Open Transcripts to read the transcript, the Runtime outcome and the ending reason.

Every text the Lab offers, from the prompts to the tool descriptions, is in
`src/apps/lab/content/`.

## Checks

`pnpm check` runs the format, lint, structure and type checks, builds the Lab page, dry-runs both
Workers' deployment and runs the tests. It needs no provider key.

Two browser checks run the Lab in Chromium with Playwright. They need no key either: no check
reaches a provider. Install the browser once with `pnpm exec playwright install chromium`.

- `pnpm test:lab-session` runs the Lab page against a stubbed Lab Worker.
- `pnpm test:lab-runtime-session` runs the Lab page, the Lab Worker and Runtime together. Only
  OpenAI's side of the call and the browser's microphone and peer connection are controlled.

## How it is built

- [Architecture](docs/architecture.md): the parts, and how an interview goes from its start to a
  delivered result.
- [Adding a combination](docs/adding-a-combination.md): how to add a Conversation, an execution or
  a combination.

## License

MIT. See [LICENSE](LICENSE).
