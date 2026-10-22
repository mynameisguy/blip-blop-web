#pragma once

// What the game is showing, for the browser page's touch controls (browser
// build only; see bb_ui_mode() in web_api.cpp). It changes nothing the game
// does or draws: the page only reads it to pick which controls to show.
//
//   BB_WEB_UI_MODE(mode);   // for the rest of the enclosing block
//
// sets the mode and restores the previous one when the block ends. On a
// native build it does nothing.

enum {
    BB_UI_MENU = 0,       // menus, character select, scores (the default)
    BB_UI_LEVEL = 1,      // playing a level
    BB_UI_SCENE = 2,      // cutscene or dialogue: Escape skips it
    BB_UI_PRESS_KEY = 3,  // "press a key" wait (mission briefing)
    BB_UI_TEXT = 4,       // typing a name for the hi-score table
};

#ifdef __EMSCRIPTEN__
extern int bb_web_ui_mode;

struct BBWebUiMode {
    int prev;
    explicit BBWebUiMode(int mode) : prev(bb_web_ui_mode) { bb_web_ui_mode = mode; }
    ~BBWebUiMode() { bb_web_ui_mode = prev; }
};
#define BB_WEB_UI_MODE(mode) BBWebUiMode bb_web_ui_mode_guard_(mode)
#else
#define BB_WEB_UI_MODE(mode) ((void)0)
#endif
