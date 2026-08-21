/**
 * RL Layer — Architecture & Reward Function
 * =========================================
 *
 * Goal
 * ----
 * Turn the trace corpus (every Detective → QA → Patcher run we've
 * already executed) into a training signal that makes the Detective
 * better at picking its first hypothesis.
 *
 * Why this is the "Thiel's Secret"
 * --------------------------------
 * OpenAI/Anthropic train their code models on "GitHub commits" — a
 * flat (buggy_code, fixed_code) pair. They do NOT have access to the
 * *reasoning trace* that a senior engineer produces: "I considered
 * hypothesis A, but it failed because of X, so I tried B...". Our
 * engine generates exactly that trace as a side-effect of running.
 * That trace corpus is the moat.
 *
 * Architecture
 * ------------
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Trace Corpus (already on disk: logs/swebench_*)            │
 *   │  Each trace = (bug, symptom, [hypotheses], qa_results,      │
 *   │                patch, judge_verdict)                        │
 *   └──────────────────────┬──────────────────────────────────────┘
 *                          │
 *                          ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Trace Analyzer (rl/trace_analyzer.ts)                      │
 *   │  - walks the logs/ dir                                      │
 *   │  - extracts one TraceExample per case                       │
 *   │  - computes per-hypothesis features (rank, confidence,      │
 *   │    qa_exposed_bug, patcher_verified, judge_score)           │
 *   └──────────────────────┬──────────────────────────────────────┘
 *                          │
 *                          ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Reward Function (rl/reward.ts)                             │
 *   │  - maps each hypothesis → a scalar reward in [-1, +1]       │
 *   │  - rewards: bug-exposing QA, patcher verified, judge eq     │
 *   │  - penalises: wasted iterations, wrong patches, no_patch    │
 *   └──────────────────────┬──────────────────────────────────────�
 *                          │
 *                          ▼
 *   ┌──────────────────────────────┬─────────────────────────────┐
 *   │  Preference Dataset Builder  │  Reward Model Trainer        │
 *   │  (rl/preference_dataset.ts)  │  (rl/reward_model.ts)       │
 *   │  - emits DPO-style           │  - logistic regression on   │
 *   │    (prompt, chosen, rejected)│    engineered features      │
 *   │    pairs                     │  - predicts P(hypothesis    │
 *   │                              │    leads to a fix)          │
 *   └──────────────┬───────────────┴──────────────┬──────────────┘
 *                  │                              │
 *                  ▼                              ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Integration Point (rl/prompt_optimizer.ts)                 │
 *   │  - at inference time, the Detective's prompt includes a     │
 *   │    "few-shot examples of high-reward past hypotheses"       │
 *   │    selected by the reward model                             │
 *   │  - replaces uniform "here are 3 random past wins" with      │
 *   │    reward-weighted retrieval                                │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * Reward Function (detailed)
 * ---------------------------
 * For a single hypothesis h tried on case c, with outcomes:
 *
 *   qa_exposed_bug   ∈ {true, false, null}   (did QA test fail on buggy code?)
 *   patcher_verified ∈ {true, false, null}   (did patched code pass the test?)
 *   judge_verdict    ∈ {"equivalent","partial","wrong","no_fix",null}
 *   rank             ∈ {1, 2, 3}             (Detective's confidence rank)
 *   attempts_used    ∈ {1, 2, 3}             (how many hypotheses before this one)
 *
 * reward(h, c) =
 *     +1.0   if judge_verdict == "equivalent"        // perfect fix
 *     +0.5   if judge_verdict == "partial"           // right area, imperfect
 *     +0.3   if patcher_verified && judge != "wrong" // verified but not judged
 *     +0.1   if qa_exposed_bug                       // bug-exposing test
 *     -0.2   if judge_verdict == "wrong"             // confidently wrong
 *     -0.3   if patcher_verified == false             // patch broke things
 *     -0.1 * (rank - 1)                              // prefer top-ranked
 *     -0.05 * (attempts_used - 1)                    // prefer first-try wins
 *
 * Clamped to [-1, +1]. The function is intentionally simple — it's a
 * starting point. A trained reward model replaces it once we have
 * enough data.
 *
 * Preference Dataset (DPO-style)
 * ------------------------------
 * For each case with ≥2 hypotheses tried, emit:
 *
 *   {
 *     "prompt": "<buggy code>\n<symptom>\nGenerate 3 hypotheses.",
 *     "chosen": "<hypothesis text with highest reward>",
 *     "rejected": "<hypothesis text with lowest reward>",
 *     "chosen_reward": 0.7,
 *     "rejected_reward": -0.3
 *   }
 *
 * This is the exact format DPO/RLHF trainers consume. We can't run a
 * full DPO training loop in this PoC (no GPU), but we CAN:
 *   1. build the dataset;
 *   2. train a simple logistic-regression reward model on the
 *      engineered features as a sanity check that the signal is real;
 *   3. wire the reward model into the Detective's prompt as a
 *      retrieval signal.
 *
 * What this PoC will NOT do (production scope):
 *   - Fine-tune the underlying LLM (needs GPU + LoRA setup).
 *   - Online RL (the closed loop is too slow for online learning).
 *   - Multi-step trajectory optimisation (we treat each hypothesis
 *     as an independent arm of a bandit, which is a reasonable
 *     approximation given the closed-loop structure).
 */
