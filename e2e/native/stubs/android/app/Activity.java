package android.app; public abstract class Activity extends android.content.Context {
  public static final int RESULT_OK=-1, RESULT_CANCELED=0;
  public void runOnUiThread(Runnable r){ r.run(); } public android.view.Window getWindow(){ return null; }
  public java.io.File getCacheDir(){ return null; } public android.content.pm.PackageManager getPackageManager(){ return null; }
  public String getPackageName(){ return ""; } public void startActivity(android.content.Intent i){}
  public android.content.Intent getIntent(){ return null; } public void setResult(int c){} public void setResult(int c, android.content.Intent d){} public void finish(){} }
