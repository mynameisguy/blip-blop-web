/******************************************************************
*
*
*		--------------
*		  Config.cpp
*		--------------
*
*		Contient toutes les données sur la config
*		et quelques fonctions pour la gérer.
*
*
*		Prosper / LOADED -   V 0.2
*
*
*
******************************************************************/

#include <stdio.h>
#include "dd_gfx.h"
#include "ben_debug.h"
#include "config.h"
#include "input.h"
#include "control_alias.h"
#include "fmod.h"
#include "globals.h"
#include "harness.h"

bool	vSyncOn = true;

int		mem_flag = DDSURF_BEST;
bool	video_buffer_on = true;
bool	mustFixGforceBug = false;

int		lang_type = LANG_UK;

bool	music_on = true;
bool	sound_on = true;

bool	cheat_on = false;

HiScores	hi_scores;

bool	winSet;
bool fullscreen = false; // THIS IS UGLY AS FUCK. WAY TOO MANY GLOBALS


void load_BB3_config(const char * cfg_file)
{
	FILE *	fic;
	int		a;

	// Test harness: BB_DEFAULT_CONFIG=1 ignores the saved key bindings.
	fic = bb_env_int("BB_DEFAULT_CONFIG", 0) ? NULL : fopen(cfg_file, "rb");

	if (fic == NULL) {
		debug << "Cannot find config file. Will use default config.\n";
		set_default_config(true);
	} else {
		debug << "Using " << cfg_file << " as configuration file.\n";

		fread(&vSyncOn, sizeof(vSyncOn), 1, fic);
		fread(&fullscreen, sizeof(fullscreen), 1, fic);
		fread(&lang_type, sizeof(lang_type), 1, fic);
#ifdef __EMSCRIPTEN__
		// A damaged save can hold any byte in these bools (a 2 made VSYNC
		// impossible to turn off): read them as bytes, keep 0 or 1.
		vSyncOn = *(unsigned char *)&vSyncOn != 0;
		fullscreen = *(unsigned char *)&fullscreen != 0;
#endif

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P1_UP, a);

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P1_DOWN, a);

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P1_LEFT, a);

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P1_RIGHT, a);

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P1_FIRE, a);

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P1_JUMP, a);

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P1_SUPER, a);


		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P2_UP, a);

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P2_DOWN, a);

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P2_LEFT, a);

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P2_RIGHT, a);

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P2_FIRE, a);

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P2_JUMP, a);

		fread(&a, sizeof(a), 1, fic);
		in.setAlias(ALIAS_P2_SUPER, a);

		fclose(fic);
	}

	lang_type = LANG_UK;
}

void save_BB3_config(const char * cfg_file)
{
	FILE *	fic;
	int		a;

	fic = fopen(cfg_file, "wb");

	if (fic == NULL) {
		debug << "Cannot save config file.\n";
	} else {
		debug << "Saving " << cfg_file << " as configuration file.\n";


		fwrite(&vSyncOn, sizeof(vSyncOn), 1, fic);
		fwrite(&fullscreen, sizeof(fullscreen), 1, fic);
		fwrite(&lang_type, sizeof(lang_type), 1, fic);

		a = in.getAlias(ALIAS_P1_UP);
		fwrite(&a, sizeof(a), 1, fic);

		a = in.getAlias(ALIAS_P1_DOWN);
		fwrite(&a, sizeof(a), 1, fic);

		a = in.getAlias(ALIAS_P1_LEFT);
		fwrite(&a, sizeof(a), 1, fic);

		a = in.getAlias(ALIAS_P1_RIGHT);
		fwrite(&a, sizeof(a), 1, fic);

		a = in.getAlias(ALIAS_P1_FIRE);
		fwrite(&a, sizeof(a), 1, fic);

		a = in.getAlias(ALIAS_P1_JUMP);
		fwrite(&a, sizeof(a), 1, fic);

		a = in.getAlias(ALIAS_P1_SUPER);
		fwrite(&a, sizeof(a), 1, fic);


		a = in.getAlias(ALIAS_P2_UP);
		fwrite(&a, sizeof(a), 1, fic);

		a = in.getAlias(ALIAS_P2_DOWN);
		fwrite(&a, sizeof(a), 1, fic);

		a = in.getAlias(ALIAS_P2_LEFT);
		fwrite(&a, sizeof(a), 1, fic);

		a = in.getAlias(ALIAS_P2_RIGHT);
		fwrite(&a, sizeof(a), 1, fic);

		a = in.getAlias(ALIAS_P2_FIRE);
		fwrite(&a, sizeof(a), 1, fic);

		a = in.getAlias(ALIAS_P2_JUMP);
		fwrite(&a, sizeof(a), 1, fic);

		a = in.getAlias(ALIAS_P2_SUPER);
		fwrite(&a, sizeof(a), 1, fic);

		fclose(fic);
	}
}

void set_default_config(bool reset_lang)
{
	if (reset_lang)
		lang_type = LANG_UK;

	in.setAlias(ALIAS_P1_UP, DIK_UP);
	in.setAlias(ALIAS_P1_DOWN, DIK_DOWN);
	in.setAlias(ALIAS_P1_LEFT, DIK_LEFT);
	in.setAlias(ALIAS_P1_RIGHT, DIK_RIGHT);
	in.setAlias(ALIAS_P1_FIRE, DIK_LCONTROL);
	in.setAlias(ALIAS_P1_JUMP, DIK_LMENU);
	in.setAlias(ALIAS_P1_SUPER, DIK_SPACE);

	in.setAlias(ALIAS_P2_UP, DIK_Q);
	in.setAlias(ALIAS_P2_DOWN, DIK_S);
	in.setAlias(ALIAS_P2_LEFT, DIK_D);
	in.setAlias(ALIAS_P2_RIGHT, DIK_F);
	in.setAlias(ALIAS_P2_FIRE, DIK_TAB);
	in.setAlias(ALIAS_P2_JUMP, DIK_G);
	in.setAlias(ALIAS_P2_SUPER, DIK_H);
}

#ifdef __EMSCRIPTEN__
#include <emscripten.h>

// The same files main() loads at start and saves at exit.
static const char WEB_CONFIG_FILE[] = "data/bb.cfg";
static const char WEB_HISCORES_FILE[] = "data/bb.scr";

// Set once main() has loaded both files, so a save from the page never
// writes uninitialised settings over them.
static bool web_saves_loaded = false;

static void web_persist(const char * file)
{
	EM_ASM({ if (Module.bbPersistSave) Module.bbPersistSave(UTF8ToString($0)); }, file);
}

void web_save_config()
{
	save_BB3_config(WEB_CONFIG_FILE);
	web_persist(WEB_CONFIG_FILE);
}

void web_save_hi_scores()
{
	if (!hi_scores.save(WEB_HISCORES_FILE))
		debug << "Cannot save hi-scores\n";
	web_persist(WEB_HISCORES_FILE);
}

void web_saves_ready()
{
	web_saves_loaded = true;
}

// The page calls this when it is hidden or closed: the browser counterpart
// of the saves at the end of main().
extern "C" EMSCRIPTEN_KEEPALIVE void bb_web_save_all()
{
	if (!web_saves_loaded)
		return;
	web_save_hi_scores();
	web_save_config();
}
#endif
