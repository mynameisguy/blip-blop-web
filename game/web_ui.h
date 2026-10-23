#pragma once

// What the game is showing, for the browser page's touch controls (browser
// build only; see bb_ui_mode() in web_api.cpp). It changes nothing the game
// does or draws: the page only reads it to pick which controls to show.
//
//   BB_WEB_UI_MODE(mode);   // for the rest of the enclosing block
//
// sets the mode and restores the previous one when the block ends.
// BB_WEB_TEXT_ENTRY() and BB_WEB_TEXT_READY(on) mark a hi-score name entry
// and when it reads keys (bb_ui_text_seq() and bb_ui_text_ready()). On a
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
extern int bb_web_text_seq;    // hi-score name entries so far
extern int bb_web_text_ready;  // 1 while a name entry reads keys
#define BB_WEB_TEXT_ENTRY() (++bb_web_text_seq, bb_web_text_ready = 0)
#define BB_WEB_TEXT_READY(on) (bb_web_text_ready = (on))

struct BBWebUiMode {
    int prev;
    explicit BBWebUiMode(int mode) : prev(bb_web_ui_mode) { bb_web_ui_mode = mode; }
    ~BBWebUiMode() { bb_web_ui_mode = prev; }
};
#define BB_WEB_UI_MODE(mode) BBWebUiMode bb_web_ui_mode_guard_(mode)
#else
#define BB_WEB_UI_MODE(mode) ((void)0)
#define BB_WEB_TEXT_ENTRY() ((void)0)
#define BB_WEB_TEXT_READY(on) ((void)0)
#endif
