// Functions the browser page can call (browser build only).
#ifdef __EMSCRIPTEN__

#include <emscripten.h>

#include <SDL.h>

#include <string>

#include "control_alias.h"
#include "input.h"
#include "key_translator.h"
#include "web_ui.h"

// The current key bindings, named as the Options > Keys menu names them:
// "<alias>=<key name>" lines for both players. The page shows them in its
// controls panel, so it always matches the game's real settings.
extern "C" EMSCRIPTEN_KEEPALIVE const char* bb_key_bindings() {
    static const struct {
        const char* name;
        int alias;
    } aliases[] = {
        {"P1_UP", ALIAS_P1_UP},       {"P1_DOWN", ALIAS_P1_DOWN},
        {"P1_LEFT", ALIAS_P1_LEFT},   {"P1_RIGHT", ALIAS_P1_RIGHT},
        {"P1_FIRE", ALIAS_P1_FIRE},   {"P1_JUMP", ALIAS_P1_JUMP},
        {"P1_SUPER", ALIAS_P1_SUPER}, {"P2_UP", ALIAS_P2_UP},
        {"P2_DOWN", ALIAS_P2_DOWN},   {"P2_LEFT", ALIAS_P2_LEFT},
        {"P2_RIGHT", ALIAS_P2_RIGHT}, {"P2_FIRE", ALIAS_P2_FIRE},
        {"P2_JUMP", ALIAS_P2_JUMP},   {"P2_SUPER", ALIAS_P2_SUPER},
    };
    static std::string out;
    out.clear();
    for (const auto& a : aliases) {
        out += a.name;
        out += '=';
        out += DIK_to_string(in.getAlias(a.alias));
        out += '\n';
    }
    return out.c_str();
}

// The raw SDL keycodes of the same bindings, in the same order, separated by
// commas. The page's touch controls send these keys.
extern "C" EMSCRIPTEN_KEEPALIVE const char* bb_key_codes() {
    static const int aliases[] = {
        ALIAS_P1_UP,   ALIAS_P1_DOWN,  ALIAS_P1_LEFT,  ALIAS_P1_RIGHT,
        ALIAS_P1_FIRE, ALIAS_P1_JUMP,  ALIAS_P1_SUPER, ALIAS_P2_UP,
        ALIAS_P2_DOWN, ALIAS_P2_LEFT,  ALIAS_P2_RIGHT, ALIAS_P2_FIRE,
        ALIAS_P2_JUMP, ALIAS_P2_SUPER,
    };
    static std::string out;
    out.clear();
    for (int a : aliases) {
        if (!out.empty()) out += ',';
        out += std::to_string(in.getAlias(a));
    }
    return out.c_str();
}

// What the game is showing (BB_UI_* in web_ui.h): the page shows menu
// controls, level controls or a Skip button to match. The game sets it
// where it enters and leaves a level, the pause menu, a cutscene, a
// dialogue scene and the briefing's "press a key" wait.
int bb_web_ui_mode = BB_UI_MENU;

extern "C" EMSCRIPTEN_KEEPALIVE int bb_ui_mode() { return bb_web_ui_mode; }

// Presses (down = 1) or releases a key given by its SDL keycode, as the
// game's key bindings store it, by queueing the SDL key event a keyboard
// would. The page's touch controls use it for bound keys that no browser
// key event can produce, such as SDLK_MENU (the default Jump key, DIK_LMENU)
// or SDLK_KP_DECIMAL. Pad bindings are not keys and are ignored.
extern "C" EMSCRIPTEN_KEEPALIVE void bb_web_key(int keycode, int down) {
    unsigned int k = (unsigned int)keycode;
    if (k == 0 || (((k >> 10) & 0xFF) > 0 && !(k & SDLK_SCANCODE_MASK))) return;
    SDL_Event e;
    SDL_zero(e);
    e.type = down ? SDL_KEYDOWN : SDL_KEYUP;
    e.key.state = down ? SDL_PRESSED : SDL_RELEASED;
    e.key.keysym.sym = (SDL_Keycode)k;
    e.key.keysym.scancode = SDL_GetScancodeFromKey((SDL_Keycode)k);
    SDL_PushEvent(&e);
}

#endif
