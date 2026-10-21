// Functions the browser page can call (browser build only).
#ifdef __EMSCRIPTEN__

#include <emscripten.h>

#include <string>

#include "control_alias.h"
#include "input.h"
#include "key_translator.h"

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

#endif
