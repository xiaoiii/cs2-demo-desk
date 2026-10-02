param([Parameter(Mandatory=$true)][string]$CommandBase64)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class DemoDeskInput {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION data; }
 [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public MOUSEINPUT mouse; }
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk;public ushort scan;public uint flags;public uint time;public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {public int x,y; public uint data,flags,time;public UIntPtr extra;}
 [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint n,INPUT[] i,int size);
 public static void Key(ushort vk,bool up) { var i=new INPUT(); i.type=1;i.data.keyboard.vk=vk;i.data.keyboard.flags=up?2u:0u;if(SendInput(1,new[]{i},Marshal.SizeOf(typeof(INPUT)))!=1)throw new Exception("Cannot send game input"); }
 public static void Tap(ushort vk){Key(vk,false);Key(vk,true);}
}
'@
$game=Get-Process -Name cs2 -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1
if(-not $game){throw 'CS2 window is not available'}
$text=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CommandBase64))
if($text.Length -gt 2048 -or $text.Contains("`n") -or $text.Contains("`r")){throw 'Invalid game command'}
$original=[System.Windows.Forms.Clipboard]::GetDataObject()
try {
 [DemoDeskInput]::ShowWindow($game.MainWindowHandle,9)|Out-Null
 [DemoDeskInput]::SetForegroundWindow($game.MainWindowHandle)|Out-Null
 Start-Sleep -Milliseconds 300
 if([DemoDeskInput]::GetForegroundWindow() -ne $game.MainWindowHandle){throw 'Cannot focus CS2; run OBS and Demo Desk at matching privileges'}
 [System.Windows.Forms.Clipboard]::SetText($text)
 [DemoDeskInput]::Tap(0xC0)
 Start-Sleep -Milliseconds 250
 [DemoDeskInput]::Key(0x11,$false);[DemoDeskInput]::Tap(0x41);[DemoDeskInput]::Key(0x11,$true)
 [DemoDeskInput]::Key(0x11,$false);[DemoDeskInput]::Tap(0x56);[DemoDeskInput]::Key(0x11,$true)
 Start-Sleep -Milliseconds 100
 [DemoDeskInput]::Tap(0x0D)
 Start-Sleep -Milliseconds 250
 [DemoDeskInput]::Tap(0xC0)
} finally {if($original){[System.Windows.Forms.Clipboard]::SetDataObject($original,$true)}}
