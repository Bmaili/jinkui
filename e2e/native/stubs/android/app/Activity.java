package android.app; public abstract class Activity extends android.content.Context {
  public void runOnUiThread(Runnable r){ r.run(); } public android.view.Window getWindow(){ return null; }
  public java.io.File getCacheDir(){ return null; } public android.content.pm.PackageManager getPackageManager(){ return null; }
  public String getPackageName(){ return ""; } public void startActivity(android.content.Intent i){} }
