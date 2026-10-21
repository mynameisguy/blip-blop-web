#include "harness.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
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
    const char* dump_dir = nullptr;
    std::uint32_t frame = 0;
    std::uint32_t virtual_ms = 0;
    std::uint32_t calls_since_frame = 0;
    std::multimap<std::uint32_t, ScriptedKey> script;

    Harness() {
        if (const char* s = getenv("BB_FIXED_STEP_MS")) step_ms = atoi(s);
        if (const char* s = getenv("BB_DUMP_EVERY")) dump_every = atoi(s);
        if (dump_every < 1) dump_every = 1;
        if (const char* s = getenv("BB_MAX_FRAMES")) max_frames = atoi(s);
        dump_dir = getenv("BB_DUMP_DIR");
        if (const char* path = getenv("BB_INPUT_SCRIPT")) LoadScript(path);
    }

    void LoadScript(const char* path) {
        FILE* f = fopen(path, "r");
        if (!f) return;
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

void bb_on_frame(SDL_Surface* frame) {
    Harness& h = harness();
    std::uint32_t n = h.frame++;

    if (n % h.dump_every == 0) {
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
            SDL_SaveBMP(frame, path);
        }
#endif
    }

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
        exit(0);
#endif
    }
}
