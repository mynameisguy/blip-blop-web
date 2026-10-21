#include "harness.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <set>
#include <string>
#include <vector>

#include <SDL2/SDL.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

static unsigned int rand_state = 1;

extern "C" int bb_rand(void) {
    rand_state = rand_state * 214013u + 2531011u;
    return (rand_state >> 16) & 0x7fff;
}

extern "C" void bb_srand(unsigned int seed) { rand_state = seed; }

namespace {

struct ScriptedKey {
    bool down;
    SDL_Keycode key;
};

struct Harness {
    int step_ms = 0;
    int dump_every = 1;
    int max_frames = 0;
    int hash_every = 0;
    const char* dump_dir = nullptr;
    FILE* hash_file = nullptr;
    bool io_error = false;
    std::uint32_t frame = 0;
    std::uint32_t virtual_ms = 0;
    std::uint32_t calls_since_frame = 0;
    std::multimap<std::uint32_t, ScriptedKey> script;
    std::set<std::uint32_t> dump_frames;

    Harness() {
        if (const char* s = getenv("BB_FIXED_STEP_MS")) step_ms = atoi(s);
        if (const char* s = getenv("BB_DUMP_EVERY")) dump_every = atoi(s);
        if (dump_every < 1) dump_every = 1;
        if (const char* s = getenv("BB_MAX_FRAMES")) max_frames = atoi(s);
        dump_dir = getenv("BB_DUMP_DIR");
        if (const char* s = getenv("BB_DUMP_FRAMES")) {
            for (char* end; *s; s = *end ? end + 1 : end) {
                unsigned long n = strtoul(s, &end, 10);
                if (end == s) break;
                dump_frames.insert(n);
            }
        }
        if (const char* s = getenv("BB_HASH_EVERY")) hash_every = atoi(s);
#ifndef __EMSCRIPTEN__
        if (const char* path = getenv("BB_HASH_FILE")) {
            hash_file = fopen(path, "w");
            if (!hash_file) Fail("cannot write BB_HASH_FILE");
        }
#endif
        if (const char* path = getenv("BB_INPUT_SCRIPT")) LoadScript(path);
    }

    static void Fail(const char* what) {
        fprintf(stderr, "harness: %s\n", what);
        exit(4);
    }

    void LoadScript(const char* path) {
        FILE* f = fopen(path, "r");
        if (!f) Fail("cannot read BB_INPUT_SCRIPT");
        char line[256];
        while (fgets(line, sizeof(line), f)) {
            unsigned frame_no;
            char action[16], name[64];
            if (sscanf(line, "%u %15s %63[^\n]", &frame_no, action, name) != 3)
                continue;
            SDL_Keycode key = SDL_GetKeyFromName(name);
            if (key == SDLK_UNKNOWN) continue;
            script.insert({frame_no, {strcmp(action, "down") == 0, key}});
        }
        fclose(f);
    }
};

Harness& harness() {
    static Harness h;
    return h;
}

}  // namespace

int bb_env_int(const char* name, int fallback) {
    const char* s = getenv(name);
    return (s && *s) ? atoi(s) : fallback;
}

std::uint32_t bb_ticks() {
    Harness& h = harness();
    if (h.step_ms <= 0) return SDL_GetTicks();
    // Some loops wait on the clock without drawing. Let virtual time creep
    // forward so they finish; it stays deterministic.
    if (++h.calls_since_frame > 1000) {
        h.calls_since_frame = 0;
        h.virtual_ms++;
    }
    return h.virtual_ms;
}

// FNV-1a over the first three bytes of every pixel (the colour; the fourth
// is unused), row by row. The same code runs in both builds, so equal hashes
// mean equal pictures whatever the surface layout.
static std::uint64_t frame_hash(const SDL_Surface* frame) {
    std::uint64_t h = 1469598103934665603ull;
    const std::uint8_t* row = static_cast<const std::uint8_t*>(frame->pixels);
    for (int y = 0; y < frame->h; y++, row += frame->pitch) {
        for (int x = 0; x < frame->w; x++) {
            for (int c = 0; c < 3; c++) {
                h ^= row[4 * x + c];
                h *= 1099511628211ull;
            }
        }
    }
    return h;
}

// Leaves at BB_MAX_FRAMES. The game is mid-frame, so skip static destructors
// (they tear down live game objects and crashed): flush what the harness
// wrote and _Exit, with status 3 if a dump could not be written.
static void quit(Harness& h) {
    if (h.hash_file && fclose(h.hash_file) != 0) h.io_error = true;
    h.hash_file = nullptr;
    fflush(stdout);
    fflush(stderr);
    if (h.io_error) fprintf(stderr, "harness: writing frames failed\n");
    _Exit(h.io_error ? 3 : 0);
}

// One step of the harness clock: advances virtual time, delivers the input
// script events due on the next step and stops at BB_MAX_FRAMES.
static void tick(Harness& h) {
    std::uint32_t n = h.frame++;

    if (h.step_ms > 0) {
        h.virtual_ms += h.step_ms;
        h.calls_since_frame = 0;
    }

    auto range = h.script.equal_range(n + 1);
    for (auto it = range.first; it != range.second; ++it) {
        SDL_Event e;
        SDL_zero(e);
        e.type = it->second.down ? SDL_KEYDOWN : SDL_KEYUP;
        e.key.state = it->second.down ? SDL_PRESSED : SDL_RELEASED;
        e.key.keysym.sym = it->second.key;
        e.key.keysym.scancode = SDL_GetScancodeFromKey(it->second.key);
        SDL_PushEvent(&e);
    }

    if (h.max_frames > 0 && h.frame >= (std::uint32_t)h.max_frames) {
        SDL_Event q;
        SDL_zero(q);
        q.type = SDL_QUIT;
        SDL_PushEvent(&q);
#ifdef __EMSCRIPTEN__
        EM_ASM({ if (Module.onMaxFrames) Module.onMaxFrames(); });
#else
        quit(h);
#endif
    }
}

void bb_on_frame(SDL_Surface* frame) {
    Harness& h = harness();
    std::uint32_t n = h.frame;

    // The browser build keeps running a little after BB_MAX_FRAMES.
    bool past_end = h.max_frames > 0 && n >= (std::uint32_t)h.max_frames;

    bool dump = h.dump_frames.empty() ? n % h.dump_every == 0
                                      : h.dump_frames.count(n) > 0;
    if (dump && !past_end) {
#ifdef __EMSCRIPTEN__
        // Hands the frame to the page; a test page sets Module.onFrame.
        EM_ASM(
            {
                if (Module.onFrame)
                    Module.onFrame($0, HEAPU8.subarray($1, $1 + $2 * $3), $2,
                                   $3);
            },
            n, frame->pixels, frame->pitch, frame->h);
#else
        if (h.dump_dir) {
            char path[512];
            snprintf(path, sizeof(path), "%s/frame_%06u.bmp", h.dump_dir, n);
            if (SDL_SaveBMP(frame, path) != 0) h.io_error = true;
        }
#endif
    }

    if (h.hash_every > 0 && n % h.hash_every == 0 && !past_end) {
        std::uint64_t hash = frame_hash(frame);
#ifdef __EMSCRIPTEN__
        EM_ASM({ if (Module.onFrameHash) Module.onFrameHash($0, $1 >>> 0, $2 >>> 0); },
               n, std::uint32_t(hash >> 32), std::uint32_t(hash));
#else
        if (h.hash_file &&
            fprintf(h.hash_file, "%06u %016llx\n", n,
                    (unsigned long long)hash) < 0)
            h.io_error = true;
#endif
    }

    tick(h);
}

void bb_input_wait() {
    Harness& h = harness();
    // Under the harness a blocking wait takes one step of the clock, without
    // a frame, so scripted keys reach it; steps are counted like frames.
    if (h.step_ms > 0 || !h.script.empty()) tick(h);
#ifdef __EMSCRIPTEN__
    // Give the browser a chance to deliver key events.
    emscripten_sleep(h.step_ms > 0 ? 0 : 10);
#endif
}
