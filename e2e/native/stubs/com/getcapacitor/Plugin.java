package com.getcapacitor;
public class Plugin { public android.content.Context ctx; public long lastDone=-1, firstDone=-1;
  public android.content.Context getContext(){return ctx;}
  public android.app.Activity getActivity(){return null;}
  /** Capacitor 的生命周期方法：子类不能用同名的私有方法 */
  public void load(){}
  protected void handleOnDestroy(){}
  protected void notifyListeners(String e,JSObject d){ long v=d.optLong("done",-1); if(firstDone<0) firstDone=v; lastDone=v; } }