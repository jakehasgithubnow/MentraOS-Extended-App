import os
import time
import subprocess
import requests

# Configuration
USER_ID = "jacobmurphycork@gmail.com"
SERVER_URL = "http://localhost:3000/android-control"

def get_volume():
    """Get the current macOS master volume as an integer (0-100)."""
    try:
        cmd = "output volume of (get volume settings)"
        result = subprocess.check_output(["osascript", "-e", cmd]).decode().strip()
        return int(result)
    except Exception as e:
        print(f"Error getting volume: {e}")
        return 50

def send_android_action(action, direction=None):
    """Send an android-style action to the MentraOS server."""
    try:
        payload = {"userId": USER_ID, "action": action}
        if direction:
            payload["direction"] = direction
            print(f"--> Action: {action} ({direction})")
        else:
            print(f"--> Action: {action}")
            
        requests.post(SERVER_URL, json=payload)
    except Exception as e:
        print(f"Error sending to server: {e}")

def main():
    print("---------------------------------------------")
    print("MentraOS Android-App Emulator (Volume Based)")
    print(f"Monitoring volume for user: {USER_ID}")
    print("VOLUME UP/DOWN: Cycle Choices")
    print("MUTE: Confirm Selection")
    print("---------------------------------------------")
    
    last_vol = get_volume()
    is_muted = False
    
    while True:
        try:
            current_vol = get_volume()
            
            # Check for Mute (Select)
            if current_vol == 0 and not is_muted:
                send_android_action("select")
                is_muted = True
            elif current_vol > 0:
                is_muted = False

            # Check for Up/Down (Cycle)
            if current_vol != last_vol and current_vol > 0:
                direction = "up" if current_vol > last_vol else "down"
                send_android_action("cycle", direction)
                last_vol = current_vol
                
            time.sleep(0.3)
        except KeyboardInterrupt:
            print("\nEmulator Stopped.")
            break
        except Exception as e:
            print(f"Loop Error: {e}")
            time.sleep(1)

if __name__ == "__main__":
    main()
