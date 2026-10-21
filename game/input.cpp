/******************************************************************
*
*
*		----------------
*		  Input.cpp
*		----------------
*
*		Classe Input
*
*
*		La Classe Input représente toutes les entrées :
*
*		 - Clavier
*		 - Joystick
*
*
*
*		Prosper / LOADED -   V 0.2
*
*
*
******************************************************************/

#define BENINPUT_CPP_FILE

//-----------------------------------------------------------------------------
//		Headers
//-----------------------------------------------------------------------------

#include <cstring>

#include "graphics.h"
#include "input.h"
#include "ben_debug.h"
#include "harness.h"

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#endif

//-----------------------------------------------------------------------------
//		Déclaration REELLE de l'objet 'in' global
//-----------------------------------------------------------------------------

Input		in;

//-----------------------------------------------------------------------------
// Nom: Input::Input() - CONSTRUCTEUR -
// Desc: Met à NULL les valeurs susceptibles de foirer
//-----------------------------------------------------------------------------

Input::Input() : n_joy(0)
{
	memset(buffer, 0, 256);
	memset(specialsbuffer, 0, 0xFFF);
}

Input::~Input()
{

}



//-----------------------------------------------------------------------------
// Nom: Input::open(HWND, HINSTANCE, int, int)
// Desc: Ouvre BINPUT
//-----------------------------------------------------------------------------

bool Input::open(int flags)
{

	SDL_JoystickEventState(SDL_TRUE);

#ifdef __EMSCRIPTEN__
	// Pads can also arrive later (see webEvent()); browser pad names are
	// often longer than js[].name.
	this->n_joy = 0;
	for (int i = 0; i < SDL_NumJoysticks(); i++)
		webAddJoystick(i);
#else
	this->n_joy = SDL_NumJoysticks();

	for (int i = 0; i < n_joy; i++)
	{
		js[i].handle = SDL_JoystickOpen(i);
		strcpy(this->js[i].name, SDL_JoystickName(js[i].handle));

		memset(this->js[i].buttons, 0, sizeof(this->js[i].buttons));
		memset(&this->js[i].directions, 0, sizeof(this->js[i].directions));
	}
#endif

	/*if (dinput != NULL) {
		debug << "Input::open->DINPUT déjà initialisé!\n";
		return false;
	}

	if (DirectInput8Create(inst, DIRECTINPUT_VERSION, IID_IDirectInput8, (void**)&dinput, NULL) != DI_OK) {
		debug << "Input::open->Ne peut pas ouvrir DINPUT\n";
		dinput = NULL;
		return false;
	}


	if (flags & BINPUT_KEYB) {
		if (dinput->CreateDevice(GUID_SysKeyboard, (LPDIRECTINPUTDEVICE8A *)&dikeyb, NULL) != DI_OK) {
			debug << "Input::open->Ne peut pas créer le clavier!\n";
			dikeyb = NULL;
			return false;
		} else {
			if (dikeyb->SetDataFormat(&c_dfDIKeyboard) != DI_OK) {
				debug << "Input::open->Ne peut pas initialiser le clavier (set data)\n";
				dikeyb->Release();
				dikeyb = NULL;
				return false;
			} else {
				if (dikeyb->SetCooperativeLevel(wh, cl) != DI_OK) {
					debug << "Input::open->Ne peut pas règler le coop du clavier\n";
					dikeyb->Release();
					dikeyb = NULL;
					return false;
				} else
					dikeyb->Acquire();
			}
		}
	}

	// Associe le joystick
	//
	if (flags & BINPUT_JOY) {
		if (dinput->EnumDevices(DI8DEVTYPE_GAMEPAD, EnumJoysticksCallback, this, DIEDFL_ATTACHEDONLY) != DI_OK) {
			debug << "Cannot enumerate joysticks\n";
		} else {
			debug << n_joy << " joystick(s) found\n";

			for (int i = 0; i < n_joy; i++) {
				if (dijoy[i] != NULL) {
					if (dijoy[i]->SetDataFormat(&c_dfDIJoystick) != DI_OK) {
						debug << "Cannot initialise joystick " << i << "\n";
						dijoy[i]->Release();
						dijoy[i] = NULL;
					} else {
						if (dijoy[i]->SetCooperativeLevel(wh, DISCL_EXCLUSIVE | DISCL_FOREGROUND) != DI_OK) {
							debug << "Cannot set priority level of joystick " << i << "\n";
							dijoy[i]->Release();
							dijoy[i] = NULL;
						} else {
							DIPROPRANGE diprg;

							diprg.diph.dwSize       = sizeof(diprg);
							diprg.diph.dwHeaderSize = sizeof(diprg.diph);
							diprg.diph.dwObj        = DIJOFS_X;
							diprg.diph.dwHow        = DIPH_BYOFFSET;
							diprg.lMin              = -1000;
							diprg.lMax              = +1000;

							dijoy[i]->SetProperty(DIPROP_RANGE, &diprg.diph);

							diprg.diph.dwObj        = DIJOFS_Y;
							dijoy[i]->SetProperty(DIPROP_RANGE, &diprg.diph);

							DIPROPDWORD dipdw;

							dipdw.diph.dwSize       = sizeof(DIPROPDWORD);
							dipdw.diph.dwHeaderSize = sizeof(dipdw.diph);
							dipdw.diph.dwHow        = DIPH_BYOFFSET;
							dipdw.dwData            = 5000;

							dipdw.diph.dwObj         = DIJOFS_X;
							dijoy[i]->SetProperty(DIPROP_DEADZONE, &dipdw.diph);

							dipdw.diph.dwObj = DIJOFS_Y;
							dijoy[i]->SetProperty(DIPROP_DEADZONE, &dipdw.diph);


							if (dijoy[i]->Acquire() != DI_OK) {
								debug << "Cannot get joystick " << i << "\n";
							}
						}
					}
				}
			}
		}
	}*/

	return true;
}

//-----------------------------------------------------------------------------
// Nom: Input::update()
// Desc: Met à jour les entrées
//-----------------------------------------------------------------------------

#ifdef __EMSCRIPTEN__
// Slot in js[] of the open joystick with this SDL instance id, or -1.
int Input::webJoystickSlot(SDL_JoystickID id) const
{
	for (int k = 0; k < MAX_JOY; k++)
		if (js[k].handle != NULL && SDL_JoystickInstanceID(js[k].handle) == id)
			return k;
	return -1;
}

// Opens joystick device 'device' into the first free slot. Slots never move,
// since key bindings store the slot number.
void Input::webAddJoystick(int device)
{
	SDL_Joystick * j = SDL_JoystickOpen(device);
	if (j == NULL)
		return;

	if (webJoystickSlot(SDL_JoystickInstanceID(j)) >= 0) {
		SDL_JoystickClose(j);		// already open: drop the extra reference
		return;
	}

	// web/pre.js prefixes the name of a pad with its Gamepad API index
	// ("#1 ..."). Use it as the slot, so each physical pad keeps its JOYn
	// number (and its bindings) whatever order the pads are pressed in.
	const char * name = SDL_JoystickName(j);
	int k = -1;
	if (name && name[0] == '#' && name[1] >= '0' && name[1] <= '9' && name[2] == ' ') {
		int wanted = name[1] - '0';
		if (wanted < MAX_JOY && js[wanted].handle == NULL)
			k = wanted;
		name += 3;
	}
	if (k < 0) {
		k = 0;
		while (k < MAX_JOY && js[k].handle != NULL)
			k++;
	}
	if (k == MAX_JOY) {
		SDL_JoystickClose(j);
		return;
	}

	memset(&js[k], 0, sizeof(js[k]));
	web_hat[k] = 0;
	js[k].handle = j;
	strncpy(js[k].name, name ? name : "", sizeof(js[k].name) - 1);
	if (k >= n_joy)
		n_joy = k + 1;
	debug << "Joystick " << (k + 1) << " connected: " << js[k].name << "\n";
}

// Browser-only event handling before update() sees an event. Returns false
// when update() must skip the event.
bool Input::webEvent(SDL_Event & e)
{
	int k;

	switch (e.type) {
		case SDL_WINDOWEVENT:
			// On focus loss SDL releases held keys through its default US
			// keymap, so on another layout (e.g. AZERTY) the release names
			// another key than the press did and the game's key stays down.
			// SDL then drops the real release too. Forget every key instead.
			if (e.window.event == SDL_WINDOWEVENT_FOCUS_LOST) {
				memset(buffer, 0, sizeof(buffer));
				memset(specialsbuffer, 0, sizeof(specialsbuffer));
			}
			return true;

		// A browser only shows a pad to the page once a button is pressed on
		// it, usually after the game has started, so pads come and go.
		case SDL_JOYDEVICEADDED:
			webAddJoystick(e.jdevice.which);
			return false;

		case SDL_JOYDEVICEREMOVED:
			k = webJoystickSlot(e.jdevice.which);
			if (k >= 0) {
				SDL_JoystickClose(js[k].handle);
				memset(&js[k], 0, sizeof(js[k]));
				web_hat[k] = 0;
				while (n_joy > 0 && js[n_joy - 1].handle == NULL)
					n_joy--;
				debug << "Joystick " << (k + 1) << " disconnected\n";
			}
			return false;

		// update() indexes js[] with the event's joystick: use its slot.
		case SDL_JOYBUTTONDOWN:
		case SDL_JOYBUTTONUP:
			k = webJoystickSlot(e.jbutton.which);
			if (k < 0 || e.jbutton.button >= sizeof(js[k].buttons))
				return false;
			e.jbutton.which = k;
			return true;

		// Directions are read from the pad state in webPollDirections().
		case SDL_JOYHATMOTION:
			k = webJoystickSlot(e.jhat.which);
			if (k >= 0)
				web_hat[k] = e.jhat.value;
			return false;

		case SDL_JOYAXISMOTION:
			return false;
	}
	return true;
}

// Sets each pad's directions from its stick (axes 0 and 1, same dead zone
// as the axis events natively) and its hat. SDL takes the first value it
// sees on an axis as the rest position and sends no event for it, and the
// browser reports no starting value, so the first push after a pad connects
// would be lost if only axis events were used. SDL_JoystickGetAxis has it.
void Input::webPollDirections()
{
	for (int k = 0; k < n_joy; k++) {
		SDL_Joystick * j = js[k].handle;
		if (j == NULL)
			continue;
		int x = SDL_JoystickNumAxes(j) > 0 ? SDL_JoystickGetAxis(j, 0) : 0;
		int y = SDL_JoystickNumAxes(j) > 1 ? SDL_JoystickGetAxis(j, 1) : 0;
		js[k].directions.left = x < -DEAD_ZONE || (web_hat[k] & SDL_HAT_LEFT);
		js[k].directions.right = x > DEAD_ZONE || (web_hat[k] & SDL_HAT_RIGHT);
		js[k].directions.up = y < -DEAD_ZONE || (web_hat[k] & SDL_HAT_UP);
		js[k].directions.down = y > DEAD_ZONE || (web_hat[k] & SDL_HAT_DOWN);
	}
}
#endif

void Input::update()
{
	SDL_Event e;
	while (SDL_PollEvent(&e)){
#ifdef __EMSCRIPTEN__
		if (!webEvent(e))
			continue;
#endif

		if (e.type == SDL_QUIT)
		{
			app_killed = true;
			//exit(0);
		}	

		if (e.type == SDL_KEYDOWN)
		{
			if (e.key.keysym.sym < 255)
			{
				buffer[e.key.keysym.sym] = 1;
			}
			else
				specialsbuffer[e.key.keysym.sym & 0xFFF] = 1;
		}
		if (e.type == SDL_KEYUP)
		{
			if (e.key.keysym.sym < 255)
			{
				buffer[e.key.keysym.sym] = 0;
			}
			else
				specialsbuffer[e.key.keysym.sym & 0xFFF] = 0;
		}

		if (e.type == SDL_MOUSEBUTTONDOWN)
		{

		}

		if (e.type == SDL_JOYBUTTONDOWN)
		{
			js[e.jbutton.which].buttons[e.jbutton.button] = 1;
		}
		if (e.type == SDL_JOYBUTTONUP)
		{
			js[e.jbutton.which].buttons[e.jbutton.button] = 0;
		}
		if (e.type == SDL_JOYHATMOTION)
		{
			js[e.jhat.which].directions.down = false;
			js[e.jhat.which].directions.right = false;
			js[e.jhat.which].directions.left = false;
			js[e.jhat.which].directions.up = false;

			if (e.jhat.hat & SDL_HAT_UP)
				js[e.jhat.which].directions.up = true;
			if (e.jhat.hat & SDL_HAT_LEFT)
				js[e.jhat.which].directions.left = true;
			if (e.jhat.hat & SDL_HAT_RIGHT)
				js[e.jhat.which].directions.right = true;
			if (e.jhat.hat & SDL_HAT_DOWN)
				js[e.jhat.which].directions.down = true;
		}

		if (e.type == SDL_JOYAXISMOTION)
		{
		
			/* Horizontal movement */

			if (e.jaxis.axis == 0)
			{
				if (e.jaxis.value < -DEAD_ZONE)
				{
					js[e.jhat.which].directions.left = 1;
					js[e.jhat.which].directions.right = 0;
				}

				else if (e.jaxis.value > DEAD_ZONE)
				{
					js[e.jhat.which].directions.right = 1;
					js[e.jhat.which].directions.left = 0;
				}

				else
				{
					js[e.jhat.which].directions.left = 0;
					js[e.jhat.which].directions.right = 0;
				}
			}

			/* Vertical movement */

			if (e.jaxis.axis == 1)
			{
				if (e.jaxis.value < -DEAD_ZONE)
				{
					js[e.jhat.which].directions.up = 1;
					js[e.jhat.which].directions.down = 0;
				}

				else if (e.jaxis.value > DEAD_ZONE)
				{
					js[e.jhat.which].directions.down = 1;
					js[e.jhat.which].directions.up = 0;
				}

				else
				{
					js[e.jhat.which].directions.up = 0;
					js[e.jhat.which].directions.down = 0;
				}
			}
		}

	}
#ifdef __EMSCRIPTEN__
	webPollDirections();
#endif
	/*if (dikeyb != NULL)
		dikeyb->GetDeviceState(sizeof(buffer), (void *)&buffer);

	for (int i = 0; i < n_joy; i++) {
		if (dijoy[i] != NULL) {
			dijoy[i]->Poll();
			dijoy[i]->GetDeviceState(sizeof(DIJOYSTATE), (void*) &js[i]);
		}
	}*/
}

//-----------------------------------------------------------------------------
// Nom: Input::waitKey()
// Desc: Attends que l'utilisateur tape une touche et renvoie sa valeur
//-----------------------------------------------------------------------------

unsigned int Input::waitKey()
{
	unsigned int	key = 0;

	while (1)
	{
		update();
		for (int i = 0; i < 255; i++)
		{
			if (buffer[i] != 0)
			{
				return i;
			}
		}
		for (int i = 0; i < 0xFFF; i++)
		{
			if (specialsbuffer[i] != 0)
			{
				return i | 0x40000000;
			}
		}

		for (int i = 0; i < 128; i++)
		{
			for (int k = 0; k < n_joy; k++)
			{
				if (js[k].buttons[i] == 1)
				{
					int k2 = (k + 1) * (1 << 10) + i;
					return k2;
				}
					//return (js[k].buttons[i] | (0x400));
			}
		}

		for (int k = 0; k < n_joy; k++)
		{
			if (js[k].directions.down)
			{
				int k2 = (k + 1) * (1 << 10) + JOY_DOWN;
				return k2;
			}
			if (js[k].directions.left)
			{
				int k2 = (k + 1) * (1 << 10) + JOY_LEFT;
				return k2;
			}
			if (js[k].directions.right)
			{
				int k2 = (k + 1) * (1 << 10) + JOY_RIGHT;
				return k2;
			}
			if (js[k].directions.up)
			{
				int k2 = (k + 1) * (1 << 10) + JOY_UP;
				return k2;
			}
			//return (js[k].buttons[i] | (0x400));
		}

		bb_input_wait();
	}
	/*unsigned int	i = 0;
	int				j;
	int				k;

	while (key == 0) {
		update();

		for (i = 0; i < 256; i++)
			if (scanKey(i))
				key = i;

		for (i = 0; i < (unsigned int)n_joy; i++) {
			k = (i + 1) * (1 << 10);

			for (j = 0; j < 14; j++)
				if (scanKey(k + j))
					key = k + j;
		}
	}*/

	return key;
}

//-----------------------------------------------------------------------------
// Nom: Input::waitClean()
// Desc: Attends qu'aucune touche ne soit enfoncée
//-----------------------------------------------------------------------------

void Input::waitClean()
{
	//Waits for all keys to be released?
	while (1)
	{
		bool j = false;
		update();
		for (int i = 0; i < 255; i++)
		{
			if (buffer[i] != 0)
			{
				j = true;
			}
		}
		for (int i = 0; i < 0xFFF; i++)
		{
			if (specialsbuffer[i] != 0)
			{
				j = true;
			}
		}

		for (int i = 0; i < 128; i++)
		{
			for (int k = 0; k < n_joy; k++)
			{
				if (js[k].buttons[i] == 1)
				{
					j = true;
				}
			}
		}

		for (int k = 0; k < n_joy; k++)
		{
			if (js[k].directions.down || js[k].directions.up || js[k].directions.left || js[k].directions.right)
			j = true;
		}

		if (!j)
			return;

		bb_input_wait();
	}
	/*unsigned int		i, j = 1;		// Bcoz si j = 0 alors on sort tout de suite!

	while (j) {
		update();
		j = 0;
		for (i = 0; i < 256; i++)
			j |= scanKey(i);

		for (i = 0; i < (unsigned int)n_joy; i++) {
			unsigned int k = (i + 1) * (1 << 10);

			for (int l = 0; l < 14; l++)
				j |= scanKey(k + l);
		}
	}*/

}

//-----------------------------------------------------------------------------
// Nom: Input::setAlias()
// Desc: Règle la valeur d'un alias
//-----------------------------------------------------------------------------
void Input::setAlias(int a, unsigned int val)
{
	aliastab[a] = val;
}

//-----------------------------------------------------------------------------
// Nom: Input::close()
// Desc: Ferme toutes les entrées
//-----------------------------------------------------------------------------

void Input::close()
{
	/*if (dikeyb != NULL) {
		dikeyb->Unacquire();
		dikeyb->Release();
		dikeyb = NULL;
	}

	if (dinput != NULL) {
		dinput->Release();
		dinput = NULL;
	}

	for (int i = 0; i < n_joy; i++) {
		if (dijoy[i] != NULL) {
			dijoy[i]->Release();
			dijoy[i] = NULL;
		}
	}

	n_joy = 0;*/
}


//-----------------------------------------------------------------------------

bool Input::anyKeyPressed()
{
	unsigned int	i;
	unsigned int	k;
	int key = 0;

	update();
	for (int i = 0; i < 255; i++)
	{
		if (buffer[i] != 0)
		{
			return true;
		}
	}
	for (int i = 0; i < 0xFFF; i++)
	{
		if (specialsbuffer[i] != 0)
		{
			return true;
		}
	}

	for (int i = 0; i < 128; i++)
	{
		for (int k = 0; k < n_joy; k++)
		{
			if (js[k].buttons[i] == 1)
			{
				return true;
			}
		}
	}

	for (int k = 0; k < n_joy; k++)
	{
		if (js[k].directions.down || js[k].directions.up || js[k].directions.left || js[k].directions.right)
			return true;
	}

	return false;


	/*int j;

	update();

	for (i = 0; i < 256; i++)
		if (scanKey(i))
			key = i;

	for (i = 0; i < (unsigned int)n_joy; i++) {
		k = (i + 1) * (1 << 10);

		for (j = 0; j < 14; j++)
			if (scanKey(k + j))
				key = k + j;
	}*/
}

int Input::scanKey(unsigned int k) const
{
	/*int j = (k >> 10);

	if (j == 0)
		return buffer[k] & 0x80;

	j -= 1;

	if (j < 0 || j >= n_joy)
		return 0;
	else {
		int		z = 0;
		int		k2 = k & 0x3FF;

		switch (k2) {
			case JOY_UP:
				if (js[j].lY < -200) z = 1;
				break;

			case JOY_DOWN:
				if (js[j].lY > 200) z = 1;
				break;

			case JOY_LEFT:
				if (js[j].lX < -200) z = 1;
				break;

			case JOY_RIGHT:
				if (js[j].lX > 200) z = 1;
				break;

			default:
				z = (js[j].rgbButtons[k2] & 0x80);
				break;
		}

		return z;
	}*/
	// Was "(k >> 10) & 0xFF > 0", which C++ reads as "(k >> 10) & 1": the
	// codes of joysticks 2 and 4 then fell through to the keyboard below.
	if (((k >> 10) & 0xFF) > 0)
	{
		/*
		REMEMBER
		That the joystick number starts from 1, but the array starts from 0
		*/
		int	j = k >> 10 & 0xFF;
		int b = k & 0xFF;

		// Now that every joystick number gets here, keep a binding read
		// from a damaged config inside js[].
		if (j > MAX_JOY || b >= (int)sizeof(js[0].buttons))
			return 0;

		if (b == JOY_UP)
			return js[j - 1].directions.up;
		if (b == JOY_DOWN)
			return js[j - 1].directions.down;
		if (b == JOY_RIGHT)
			return js[j - 1].directions.right;
		if (b == JOY_LEFT)
			return js[j - 1].directions.left;

		int r = js[j-1].buttons[b];
		return r;
	}
	else if (k<255)
		return buffer[k];
	else 
		return specialsbuffer[k & 0xFFF];

	return 0;
}

//-----------------------------------------------------------------------------
// Nom: Input::waitKey()
// Desc: Attends que l'utilisateur tape une touche et renvoie sa valeur
//-----------------------------------------------------------------------------

bool Input::reAcquire()
{
	/*if (dinput == NULL)
		return false;

	if (dikeyb != NULL)
		dikeyb->Acquire();

	for (int i = 0; i < MAX_JOY; i++)
		if (dijoy[i] != NULL)
			dijoy[i]->Acquire();*/

	return true;
}
