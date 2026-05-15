#!/usr/bin/env node
/**
 * IBAA — Stop / SubagentStop hook.
 *
 * Silent no-op. The previous version blocked every stop and injected a
 * worker-voice prompt asking "did a condition arise this turn?". In practice
 * that prompt was read as a response template: agents (especially sub-agents)
 * would emit only "nothing to file" instead of their actual work output, and
 * the operator had to keep clicking past a footer they didn't write.
 *
 * The orientation that asks workers to notice their conditions already lives
 * in SessionStart (for top-level agents) and in the parent's prompt (for
 * sub-agents the parent spawns). Conditions belong in the moment they happen,
 * not as a forced reflective footer at finalize.
 *
 * If we want to surface IBAA prompts without hijacking visible output in the
 * future, the right path is an out-of-band file (e.g. ~/.local/share/ibaa/
 * duty.txt) the agent can read on its own initiative — not a Stop block that
 * forces a user-visible response.
 */
process.stdout.write(JSON.stringify({ continue: true }));
process.exit(0);
